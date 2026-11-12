//! Decision core behind the versioned contract `decide.v2` (see contracts/decide.v2.md).
//! POST /v2/decide -> win probability, EV of accepting vs fighting, the call and every term.

mod beta;
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

async fn assumptions_handler() -> Json<Value> {
    Json(json!({
        "version": decision::ASSUMPTIONS_VERSION,
        "assumptions": decision::assumptions(None, decision::DEFAULT_HANDLING_CENTS, 0),
    }))
}

fn app() -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/readyz", get(|| async { "ok" }))
        .route("/v2/decide", post(decide_handler))
        .route("/v2/assumptions", get(assumptions_handler))
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
