//! Decision core behind the versioned contract `decide.v1` (see contracts/decide.v1.md).
//! POST /v1/decide -> win probability, EV of accepting vs fighting, the call and every term.

mod decision;
mod priors;

use axum::{http::StatusCode, routing::get, routing::post, Json, Router};
use decision::{decide, validate, Request};
use serde_json::{json, Value};

async fn decide_handler(
    Json(req): Json<Request>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if let Err(e) = validate(&req) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "bad_request", "detail": e })),
        ));
    }
    Ok(Json(serde_json::to_value(decide(&req)).expect("serialise")))
}

fn app() -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/readyz", get(|| async { "ok" }))
        .route("/v1/decide", post(decide_handler))
}

async fn shutdown_signal() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("install SIGTERM handler");
    tokio::select! {
        _ = term.recv() => {},
        _ = tokio::signal::ctrl_c() => {},
    }
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("bind");
    // SIGTERM: stop accepting, drain in-flight requests, exit.
    axum::serve(listener, app())
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("serve");
}

#[cfg(test)]
mod tests {
    use super::*;

    const CASES: &str = include_str!("../fixtures/decide.v1.cases.json");

    #[test]
    fn every_golden_case_matches() {
        let cases: Vec<Value> = serde_json::from_str(CASES).unwrap();
        assert!(cases.len() >= 9);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let req: Request = serde_json::from_value(c["request"].clone()).unwrap();
            validate(&req).unwrap();
            let got = serde_json::to_value(decide(&req)).unwrap();
            let want = &c["expect"];
            for key in [
                "ev_accept_cents",
                "ev_fight_cents",
                "margin_cents",
                "marginal",
                "call",
                "wins",
                "n",
                "k",
            ] {
                assert_eq!(got[key], want[key], "{name}: {key}");
            }
            for key in ["p0", "p"] {
                let (g, w) = (got[key].as_f64().unwrap(), want[key].as_f64().unwrap());
                assert!((g - w).abs() < 0.00006, "{name}: {key} {g} vs {w}");
            }
            assert_eq!(got["terms"].as_array().unwrap().len(), 4, "{name}");
        }
    }

    fn named(name: &str) -> Value {
        let cases: Vec<Value> = serde_json::from_str(CASES).unwrap();
        let c = cases.into_iter().find(|c| c["name"] == name).unwrap();
        serde_json::to_value(decide(
            &serde_json::from_value(c["request"].clone()).unwrap(),
        ))
        .unwrap()
    }

    #[test]
    fn proposal_cases() {
        let a = named("proposal-120-fight");
        assert_eq!(
            (
                a["call"].as_str().unwrap(),
                a["margin_cents"].as_i64().unwrap()
            ),
            ("fight", 5100)
        );
        let b = named("proposal-9-accept");
        assert_eq!(
            (
                b["call"].as_str().unwrap(),
                b["margin_cents"].as_i64().unwrap()
            ),
            ("accept", -1185)
        );
        let c = named("proposal-64-marginal-fight");
        assert_eq!(
            (
                c["call"].as_str().unwrap(),
                c["margin_cents"].as_i64().unwrap()
            ),
            ("fight", 420)
        );
        assert_eq!(c["marginal"], true);
    }

    #[test]
    fn terms_print_the_arithmetic() {
        let a = named("precedents-smooth-the-prior");
        let t = a["terms"].as_array().unwrap();
        assert_eq!(
            t[0],
            "p = (wins + k*p0)/(n + k) = (3 + 4*0.55)/(4 + 4) = 0.65"
        );
        assert_eq!(t[1], "EV accept = -A = -$120.00");
        assert_eq!(
            t[2],
            "EV fight = -(1-p)*(A+F) - c = -(0.35)*(120.00+0.00) - 15.00 = -$57.00"
        );
        assert_eq!(
            t[3],
            "fight - accept = p*A - (1-p)*F - c = +$63.00 -> fight"
        );
    }

    #[test]
    fn table_prior_is_used_and_labelled_when_none_is_given() {
        let r: Request = serde_json::from_value(json!({
            "contract": "decide.v1", "amount_cents": 5000, "reason": "UNAUTHORISED",
            "handling_cost_cents": 1500
        }))
        .unwrap();
        let out = decide(&r);
        assert_eq!(out.p0, 0.25);
        assert!(out.p0_source.starts_with("assumed prior"));
    }

    #[test]
    fn rejects_wrong_contract_and_negative_amounts() {
        let mut r: Request = serde_json::from_value(json!({
            "contract": "decide.v0", "amount_cents": 5000, "reason": "OTHER", "handling_cost_cents": 1
        })).unwrap();
        assert!(validate(&r).is_err());
        r.contract = "decide.v1".into();
        assert!(validate(&r).is_ok());
        r.amount_cents = -1;
        assert!(validate(&r).is_err());
        r.amount_cents = 1;
        r.fee_if_lost_cents = -5;
        assert!(validate(&r).is_err());
    }
}
