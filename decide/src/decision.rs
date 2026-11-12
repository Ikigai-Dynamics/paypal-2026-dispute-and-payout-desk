//! decide.v2: win probability smoothed toward a prior (with an 80% interval), then the EV of
//! accepting, fighting or offering a partial refund. All money is integer cents; the mean win
//! chance is held in basis points so its arithmetic is exact and rounding is half away from zero.

use crate::{beta, priors};
use serde::{Deserialize, Serialize};

pub const CONTRACT: &str = "decide.v2";
pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const ASSUMPTIONS_VERSION: &str = "2026-11-12.1";
pub const K: i128 = 4;
const BP: i128 = 10_000;
const MARGINAL_CENTS: i64 = 500;
/// Offer scan step, in cents (port of the checkout-economics-engine step-scan).
pub const STEP_CENTS: i64 = 50;
/// Share of the amount at which half of buyers accept an offer (estimated).
pub const ACCEPT_M: f64 = 0.5;
/// Steepness of the acceptance curve (estimated).
pub const ACCEPT_S: f64 = 8.0;
/// An offer is only worth making when it beats the best alternative by at least this much.
pub const OFFER_MIN_GAIN_CENTS: i64 = 500;
/// Disputes from one buyer (this one included) from which they count as a repeat disputer, with at
/// least half of their orders disputed (assumption, in disputes; the demo desk's buyers have 2 to 8).
pub const SERIAL_MIN_DISPUTES: u32 = 7;
pub const DEFAULT_HANDLING_CENTS: i64 = 1500;

#[derive(Deserialize, Debug, Clone)]
pub struct Precedent {
    #[allow(dead_code)]
    pub dispute_id: Option<String>,
    pub won: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Request {
    pub contract: String,
    pub amount_cents: i64,
    #[allow(dead_code)]
    pub currency: Option<String>,
    pub reason: String,
    #[allow(dead_code)]
    pub stage: Option<String>,
    #[serde(default)]
    pub evidence_on_file: bool,
    pub prior: Option<f64>,
    pub handling_cost_cents: i64,
    /// cost of the AI drafting work on this case
    #[serde(default)]
    pub ai_cost_cents: i64,
    #[serde(default)]
    pub fee_if_lost_cents: i64,
    #[serde(default)]
    pub precedents: Vec<Precedent>,
    /// orders this buyer has placed with the seller (optional; 0 = unknown)
    #[serde(default)]
    pub buyer_orders: u32,
    /// disputes this buyer has opened with the seller, this one included (optional)
    #[serde(default)]
    pub buyer_disputes: u32,
}

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Offer {
    pub amount_cents: i64,
    /// estimated chance the buyer takes it
    pub q: f64,
    pub ev_cents: i64,
}

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Assumption {
    pub id: String,
    pub label: String,
    pub value: f64,
    pub unit: &'static str,
    pub source: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Response {
    pub contract: &'static str,
    pub core_version: &'static str,
    pub assumptions_version: &'static str,
    pub p0: f64,
    pub p0_source: &'static str,
    pub k: i64,
    pub wins: i64,
    pub n: i64,
    pub p: f64,
    pub p_lo: f64,
    pub p_hi: f64,
    pub ai_cost_cents: i64,
    pub fight_cost_cents: i64,
    pub ev_accept_cents: i64,
    pub ev_fight_cents: i64,
    pub ev_offer_cents: Option<i64>,
    pub offer: Option<Offer>,
    pub margin_cents: i64,
    pub marginal: bool,
    pub call: &'static str,
    pub keep_cents: i64,
    /// the buyer disputes so often that Parley does not offer them a partial refund
    pub buyer_flag: bool,
    /// echoes of the request, so a screen can say "8 of 8"
    pub buyer_orders: u32,
    pub buyer_disputes: u32,
    pub assumptions: Vec<Assumption>,
    pub terms: Vec<String>,
}

/// a / b rounded half away from zero (b > 0).
fn div_round(a: i128, b: i128) -> i128 {
    let q = (a.abs() * 2 + b) / (2 * b);
    if a < 0 {
        -q
    } else {
        q
    }
}

fn money(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let a = cents.abs();
    format!("{sign}${}.{:02}", a / 100, a % 100)
}

fn signed_money(cents: i64) -> String {
    if cents >= 0 {
        format!("+{}", money(cents))
    } else {
        money(cents)
    }
}

pub fn validate(req: &Request) -> Result<(), String> {
    if req.contract != CONTRACT {
        return Err(format!("contract must be {CONTRACT}, got {}", req.contract));
    }
    if req.amount_cents < 0
        || req.handling_cost_cents < 0
        || req.fee_if_lost_cents < 0
        || req.ai_cost_cents < 0
    {
        return Err(
            "amount_cents, handling_cost_cents, ai_cost_cents and fee_if_lost_cents must not be negative"
                .into(),
        );
    }
    if let Some(p) = req.prior {
        if !(0.0..=1.0).contains(&p) || p.is_nan() {
            return Err("prior must be between 0 and 1".into());
        }
    }
    Ok(())
}

/// Chance a buyer takes an offer of x cents on a dispute of a cents.
pub fn accept_q(x: i64, a: i64) -> f64 {
    1.0 / (1.0 + (-ACCEPT_S * (x as f64 / a as f64 - ACCEPT_M)).exp())
}

fn round4(x: f64) -> f64 {
    (x * 1e4).round() / 1e4
}

fn pct(x: f64) -> String {
    format!("{}%", (x * 100.0).round() as i64)
}

fn words(reason: &str) -> String {
    reason.replace('_', " ").to_lowercase()
}

/// Reason in words for labels, e.g. "item not received".
fn reason_words(reason: &str) -> String {
    match reason {
        "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" => "item not received".into(),
        "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED" => "item not as described".into(),
        "UNAUTHORISED" => "unauthorised charge".into(),
        "DUPLICATE_TRANSACTION" => "duplicate charge".into(),
        "CREDIT_NOT_PROCESSED" => "refund not received".into(),
        "CANCELED_RECURRING_BILLING" => "cancelled subscription".into(),
        other => words(other),
    }
}

/// The assumptions behind a decision; `used` carries the p0 entry of this request
/// (value, source, reason, evidence on file).
pub fn assumptions(
    used: Option<(f64, &str, &str, bool)>,
    handling: i64,
    fee: i64,
) -> Vec<Assumption> {
    let a = |id: &str, label: &str, value: f64, unit: &'static str, source: &str| Assumption {
        id: id.into(),
        label: label.into(),
        value,
        unit,
        source: source.into(),
    };
    let p0_label = |reason: &str, ev: bool| {
        format!(
            "Typical seller win rate: {}, {}",
            reason_words(reason),
            if ev {
                "evidence on file"
            } else {
                "no evidence"
            }
        )
    };
    let mut v = vec![a(
        "k",
        "Weight of the starting guess",
        K as f64,
        "cases",
        "Weight of the starting guess, as if it were this many similar cases. Estimated.",
    )];
    match used {
        Some((p0, source, reason, ev)) => {
            v.push(a("p0", &p0_label(reason, ev), p0, "probability", source))
        }
        None => {
            for reason in priors::REASONS {
                for ev in [false, true] {
                    v.push(a(
                        &format!(
                            "p0.{reason}.{}",
                            if ev { "evidence" } else { "no_evidence" }
                        ),
                        &p0_label(reason, ev),
                        priors::prior_bp(reason, ev) as f64 / BP as f64,
                        "probability",
                        priors::SOURCE,
                    ));
                }
            }
        }
    }
    v.extend([
        a(
            "fee_if_lost",
            "Fee if you lose",
            fee as f64,
            "cents",
            "Extra fee charged when a dispute is lost. Estimated; set per seller.",
        ),
        a(
            "handling",
            "Your time per fight",
            handling as f64,
            "cents",
            "Your time to prepare and send a response. Estimated.",
        ),
        a(
            "accept_m",
            "Offer size half of buyers accept",
            ACCEPT_M,
            "share of amount",
            "Share of the amount at which half of buyers accept an offer. Estimated, not PayPal data.",
        ),
        a(
            "accept_s",
            "How quickly acceptance rises",
            ACCEPT_S,
            "steepness",
            "How quickly buyers go from refusing to accepting around that share. Estimated, not PayPal data.",
        ),
        a(
            "offer_step",
            "Offer step",
            STEP_CENTS as f64,
            "cents",
            "Offers are tried in steps of this size.",
        ),
        a(
            "offer_min_gain",
            "Smallest gain that justifies an offer",
            OFFER_MIN_GAIN_CENTS as f64,
            "cents",
            "An offer is only suggested when it beats fighting or accepting by at least this much.",
        ),
        a(
            "serial_min_disputes",
            "Disputes before a buyer counts as a repeat disputer",
            SERIAL_MIN_DISPUTES as f64,
            "disputes",
            "A buyer with at least this many disputes, covering at least half of their orders, gets no partial offer. Estimated.",
        ),
    ]);
    v
}

/// Why a partial refund is off the table for this case, if it is (a term for the working).
fn no_offer_reason(req: &Request, serial: bool) -> Option<String> {
    if serial {
        return Some(format!(
            "This buyer has disputed {} of {} orders with you, so Parley does not offer a partial refund.",
            req.buyer_disputes,
            req.buyer_orders.max(req.buyer_disputes)
        ));
    }
    match (req.reason.as_str(), req.evidence_on_file) {
        ("UNAUTHORISED", _) => Some(
            "PayPal's offer flow does not apply to unauthorised-transaction claims, so the call is to fight or refund."
                .into(),
        ),
        ("DUPLICATE_TRANSACTION" | "CREDIT_NOT_PROCESSED", false) => Some(
            "A real duplicate charge is refunded in full; a partial offer would not settle it."
                .into(),
        ),
        _ => None,
    }
}

pub fn decide(req: &Request) -> Response {
    // a pattern of disputes is evidence for the seller: p0 up 10 points, capped at 0.9
    let serial =
        req.buyer_disputes >= SERIAL_MIN_DISPUTES && req.buyer_disputes * 2 >= req.buyer_orders;
    let (p0_bp, source) = match req.prior {
        Some(p) => ((p * BP as f64).round() as i128, priors::OVERRIDE_SOURCE),
        None => (
            priors::prior_bp(&req.reason, req.evidence_on_file) as i128,
            priors::SOURCE,
        ),
    };
    let p0_bp = if serial {
        (p0_bp + 1000).min(9000)
    } else {
        p0_bp
    };
    let n = req.precedents.len() as i128;
    let wins = req.precedents.iter().filter(|p| p.won).count() as i128;
    // p = (wins + k*p0)/(n + k), in basis points (rounded, used only for display).
    let denom = n + K;
    let p_num_bp = wins * BP + K * p0_bp; // p = p_num_bp / (denom * BP)
    let p_bp = div_round(p_num_bp, denom);
    let p0 = p0_bp as f64 / BP as f64;
    let (a_post, b_post) = (
        wins as f64 + K as f64 * p0,
        (n - wins) as f64 + K as f64 * (1.0 - p0),
    );
    let (p_lo, p_hi) = (
        round4(beta::quantile(a_post, b_post, 0.10)),
        round4(beta::quantile(a_post, b_post, 0.90)),
    );

    let a = req.amount_cents as i128;
    let f = req.fee_if_lost_cents as i128;
    let c = req.handling_cost_cents as i128 + req.ai_cost_cents as i128;
    let ev_accept = -a;
    // (1-p)(A+F) = (denom*BP - p_num_bp)(A+F) / (denom*BP)
    let loss = div_round((denom * BP - p_num_bp) * (a + f), denom * BP);
    let ev_fight = -loss - c;
    let margin = ev_fight - ev_accept;
    let (ev_accept, ev_fight, margin) = (ev_accept as i64, ev_fight as i64, margin as i64);

    // Offer scan: EV(x) = q(x)(-x) + (1-q(x)) EV_fight, x from 50c to A-50c.
    let blocked = no_offer_reason(req, serial);
    let mut best: Option<Offer> = None;
    let mut x = STEP_CENTS;
    while blocked.is_none() && x <= req.amount_cents - STEP_CENTS {
        let q = accept_q(x, req.amount_cents);
        let ev = (q * -(x as f64) + (1.0 - q) * ev_fight as f64).round() as i64;
        if best.as_ref().is_none_or(|b| ev > b.ev_cents) {
            best = Some(Offer {
                amount_cents: x,
                q: round4(q),
                ev_cents: ev,
            });
        }
        x += STEP_CENTS;
    }
    // a real duplicate or unprocessed refund with nothing on file is refunded, not fought
    let refund_due = matches!(
        (req.reason.as_str(), req.evidence_on_file),
        ("DUPLICATE_TRANSACTION" | "CREDIT_NOT_PROCESSED", false)
    );
    let base_call = if ev_fight > ev_accept && !refund_due {
        "fight"
    } else {
        "accept"
    };
    let base_ev = ev_fight.max(ev_accept);
    let call = match &best {
        Some(o) if o.ev_cents > base_ev && o.ev_cents - base_ev >= OFFER_MIN_GAIN_CENTS => "offer",
        _ => base_call,
    };
    let keep = req.amount_cents
        + match call {
            "offer" => best.as_ref().map_or(0, |o| o.ev_cents),
            "fight" => ev_fight,
            _ => ev_accept,
        };

    let marginal = margin.abs() < MARGINAL_CENTS;
    let p = p_bp as f64 / BP as f64;
    let fight_cost = c as i64;
    let mut terms = vec![
        format!(
            "Estimated chance of winning: {} (80% range {} to {}), from {wins} wins in {n} similar cases and a starting guess of {}.",
            pct(p), pct(p_lo), pct(p_hi), pct(p0)
        ),
        format!("Accepting means refunding {}.", money(req.amount_cents)),
        format!(
            "Fighting costs {} of work and AI time and risks losing {}{}; on average that is {}.",
            money(fight_cost),
            money(req.amount_cents),
            if f > 0 { format!(" plus a {} fee", money(f as i64)) } else { String::new() },
            money(ev_fight)
        ),
    ];
    match &best {
        Some(o) => terms.push(format!(
            "The best partial refund to offer is {}: an estimated {} of buyers take it, and the average result is {}.",
            money(o.amount_cents), pct(o.q), money(o.ev_cents)
        )),
        None => terms.push(
            blocked
                .clone()
                .unwrap_or_else(|| "The amount is too small to offer a partial refund.".into()),
        ),
    }
    terms.push(format!(
        "Call: {call}. Likely kept: {} of {}.{}",
        money(keep),
        money(req.amount_cents),
        if call != "offer" && marginal {
            " It is a close call."
        } else {
            ""
        }
    ));
    let _ = signed_money;
    Response {
        contract: CONTRACT,
        core_version: CORE_VERSION,
        assumptions_version: ASSUMPTIONS_VERSION,
        p0,
        p0_source: source,
        k: K as i64,
        wins: wins as i64,
        n: n as i64,
        p,
        p_lo,
        p_hi,
        ai_cost_cents: req.ai_cost_cents,
        fight_cost_cents: fight_cost,
        ev_accept_cents: ev_accept,
        ev_fight_cents: ev_fight,
        ev_offer_cents: best.as_ref().map(|o| o.ev_cents),
        offer: best,
        margin_cents: margin,
        marginal,
        call,
        keep_cents: keep,
        buyer_flag: serial,
        buyer_orders: req.buyer_orders.max(req.buyer_disputes),
        buyer_disputes: req.buyer_disputes,
        assumptions: assumptions(
            Some((p0, source, &req.reason, req.evidence_on_file)),
            req.handling_cost_cents,
            req.fee_if_lost_cents,
        ),
        terms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const CASES: &str = include_str!("../fixtures/decide.v2.cases.json");

    fn req(a: i64, prior: f64, handling: i64, wins: usize, n: usize) -> Request {
        Request {
            contract: CONTRACT.into(),
            amount_cents: a,
            currency: None,
            reason: "OTHER".into(),
            stage: None,
            evidence_on_file: true,
            prior: Some(prior),
            handling_cost_cents: handling,
            ai_cost_cents: 0,
            fee_if_lost_cents: 0,
            precedents: (0..n)
                .map(|i| Precedent {
                    dispute_id: None,
                    won: i < wins,
                })
                .collect(),
            buyer_orders: 0,
            buyer_disputes: 0,
        }
    }

    #[test]
    fn every_golden_case_matches() {
        let cases: Vec<Value> = serde_json::from_str(CASES).unwrap();
        let mut calls = std::collections::BTreeSet::new();
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let r: Request = serde_json::from_value(c["request"].clone()).unwrap();
            validate(&r).unwrap();
            let got = serde_json::to_value(decide(&r)).unwrap();
            let want = &c["expect"];
            for key in [
                "ev_accept_cents",
                "ev_fight_cents",
                "ev_offer_cents",
                "margin_cents",
                "marginal",
                "call",
                "keep_cents",
                "fight_cost_cents",
                "wins",
                "n",
                "k",
            ] {
                assert_eq!(got[key], want[key], "{name}: {key}");
            }
            assert_eq!(
                got["offer"]["amount_cents"], want["offer"]["amount_cents"],
                "{name}: offer"
            );
            for key in ["p0", "p", "p_lo", "p_hi"] {
                let (g, w) = (got[key].as_f64().unwrap(), want[key].as_f64().unwrap());
                assert!((g - w).abs() < 0.0002, "{name}: {key} {g} vs {w}");
            }
            assert!(!got["terms"].as_array().unwrap().is_empty());
            calls.insert(got["call"].as_str().unwrap().to_string());
        }
        assert_eq!(
            calls.len(),
            3,
            "fight, accept and offer each have a golden case"
        );
    }

    #[test]
    fn offer_is_below_the_amount_and_beats_both_when_chosen() {
        for a in [100, 150, 900, 2500, 12000, 131700, 500_000] {
            for p in (0..=100).map(|i| i as f64 / 100.0) {
                let r = decide(&req(a, p, 1500, 0, 0));
                if let Some(o) = &r.offer {
                    assert!(o.amount_cents < a && o.amount_cents >= STEP_CENTS);
                    assert!(o.q > 0.0 && o.q < 1.0);
                }
                if r.call == "offer" {
                    let ev = r.ev_offer_cents.unwrap();
                    assert!(
                        ev > r.ev_fight_cents && ev > r.ev_accept_cents,
                        "a={a} p={p}"
                    );
                    assert_eq!(r.keep_cents, a + ev);
                }
            }
        }
        assert!(decide(&req(100, 0.5, 1500, 0, 0)).offer.is_some());
        assert!(decide(&req(99, 0.5, 1500, 0, 0)).offer.is_none());
    }

    #[test]
    fn call_never_moves_toward_accept_as_p_rises() {
        let rank = |c: &str| match c {
            "accept" => 0,
            "offer" => 1,
            _ => 2,
        };
        for a in [900, 2500, 5000, 12000, 50_000, 131700] {
            let mut last = 0;
            for p in (0..=100).map(|i| i as f64 / 100.0) {
                let r = rank(decide(&req(a, p, 1500, 0, 0)).call);
                assert!(r >= last, "a={a} p={p}");
                last = r;
            }
        }
    }

    #[test]
    fn interval_contains_p_and_narrows_with_cases() {
        let mut width = f64::MAX;
        for n in [0, 4, 12, 40] {
            let r = decide(&req(12000, 0.5, 1500, n / 2, n));
            assert!(r.p_lo < r.p && r.p < r.p_hi, "n={n}");
            assert!(r.p_hi - r.p_lo < width, "n={n}");
            width = r.p_hi - r.p_lo;
        }
    }

    #[test]
    fn ai_cost_adds_to_the_fight_cost() {
        let mut r = req(12000, 0.55, 1500, 0, 0);
        r.ai_cost_cents = 25;
        let out = decide(&r);
        assert_eq!((out.fight_cost_cents, out.ev_fight_cents), (1525, -6925));
        r.ai_cost_cents = -1;
        assert!(validate(&r).is_err());
    }

    #[test]
    fn table_prior_is_used_and_labelled_when_none_is_given() {
        let r: Request = serde_json::from_value(json!({
            "contract": "decide.v2", "amount_cents": 5000, "reason": "UNAUTHORISED",
            "handling_cost_cents": 1500
        }))
        .unwrap();
        let out = decide(&r);
        assert_eq!(out.p0, 0.25);
        assert!(out.p0_source.starts_with("Parley"));
        assert!(out.assumptions.iter().any(|a| a.id == "accept_m"));
    }

    fn with(reason: &str, evidence: bool, a: i64, orders: u32, disputes: u32) -> Request {
        let mut r = req(a, 0.3, 1500, 0, 0);
        r.prior = None;
        r.reason = reason.into();
        r.evidence_on_file = evidence;
        r.buyer_orders = orders;
        r.buyer_disputes = disputes;
        r
    }

    #[test]
    fn unauthorised_is_never_offered() {
        for a in [900, 5000, 20300, 131_700] {
            let out = decide(&with("UNAUTHORISED", true, a, 0, 0));
            assert!(out.offer.is_none() && out.call != "offer", "a={a}");
            assert!(out.terms.iter().any(|t| t.contains("unauthorised")));
        }
    }

    #[test]
    fn duplicate_or_credit_without_evidence_is_refunded() {
        for reason in ["DUPLICATE_TRANSACTION", "CREDIT_NOT_PROCESSED"] {
            let out = decide(&with(reason, false, 16400, 0, 0));
            for a in [1500, 16400, 58800] {
                let out = decide(&with(reason, false, a, 0, 0));
                assert_eq!(out.call, "accept", "{reason} {a}");
                assert_eq!(out.keep_cents, 0);
            }
            assert!(out.offer.is_none());
            assert!(out.terms.iter().any(|t| t.contains("refunded in full")));
        }
    }

    #[test]
    fn serial_disputer_gets_no_offer_and_a_higher_prior() {
        let base = decide(&with(
            "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
            false,
            58800,
            20,
            2,
        ));
        assert!(!base.buyer_flag);
        let out = decide(&with(
            "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
            false,
            58800,
            8,
            8,
        ));
        assert!(out.buyer_flag && out.offer.is_none() && out.call != "offer");
        assert!((out.p0 - base.p0 - 0.10).abs() < 1e-9);
        assert!(out
            .terms
            .iter()
            .any(|t| t.contains("disputed 8 of 8 orders with you")));
        // fewer than 3 disputes, or under half of the orders: not serial
        let n = SERIAL_MIN_DISPUTES;
        assert!(!decide(&with("OTHER", false, 5000, n - 1, n - 1)).buyer_flag);
        assert!(!decide(&with("OTHER", false, 5000, 3 * n, n)).buyer_flag);
        assert!(decide(&with("OTHER", false, 5000, 2 * n, n)).buyer_flag);
        // capped at 0.9
        let mut r = with("OTHER", true, 5000, 7, 7);
        r.prior = Some(0.85);
        assert_eq!(decide(&r).p0, 0.9);
    }

    #[test]
    fn rejects_wrong_contract_and_negative_amounts() {
        let mut r = req(5000, 0.5, 1, 0, 0);
        r.contract = "decide.v1".into();
        assert!(validate(&r).is_err());
        r.contract = CONTRACT.into();
        assert!(validate(&r).is_ok());
        r.amount_cents = -1;
        assert!(validate(&r).is_err());
        r.amount_cents = 1;
        r.fee_if_lost_cents = -5;
        assert!(validate(&r).is_err());
    }
}
