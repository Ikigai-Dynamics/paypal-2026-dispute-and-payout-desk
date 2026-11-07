//! decide.v1: win probability smoothed toward a prior, then the EV of accepting vs fighting.
//! All money is integer cents; probabilities are held as integer basis points so the
//! arithmetic is exact and rounding is half away from zero.

use crate::priors;
use serde::{Deserialize, Serialize};

pub const CONTRACT: &str = "decide.v1";
pub const K: i128 = 4;
const BP: i128 = 10_000;
const MARGINAL_CENTS: i64 = 500;

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
    #[serde(default)]
    pub fee_if_lost_cents: i64,
    #[serde(default)]
    pub precedents: Vec<Precedent>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Response {
    pub contract: &'static str,
    pub p0: f64,
    pub p0_source: &'static str,
    pub k: i64,
    pub wins: i64,
    pub n: i64,
    pub p: f64,
    pub ev_accept_cents: i64,
    pub ev_fight_cents: i64,
    pub margin_cents: i64,
    pub marginal: bool,
    pub call: &'static str,
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

fn plain(cents: i64) -> String {
    let a = cents.abs();
    format!("{}.{:02}", a / 100, a % 100)
}

/// A basis-point value as a decimal without trailing zeros: 5500 -> "0.55", 5625 -> "0.5625".
fn bp_text(bp: i128) -> String {
    let s = format!("{:04}", bp.abs());
    let (int, frac) = s.split_at(s.len() - 4);
    let frac = frac.trim_end_matches('0');
    let int = if int.is_empty() { "0" } else { int };
    if frac.is_empty() {
        int.to_string()
    } else {
        format!("{int}.{frac}")
    }
}

pub fn validate(req: &Request) -> Result<(), String> {
    if req.contract != CONTRACT {
        return Err(format!("contract must be {CONTRACT}, got {}", req.contract));
    }
    if req.amount_cents < 0 || req.handling_cost_cents < 0 || req.fee_if_lost_cents < 0 {
        return Err(
            "amount_cents, handling_cost_cents and fee_if_lost_cents must not be negative".into(),
        );
    }
    if let Some(p) = req.prior {
        if !(0.0..=1.0).contains(&p) || p.is_nan() {
            return Err("prior must be between 0 and 1".into());
        }
    }
    Ok(())
}

pub fn decide(req: &Request) -> Response {
    let (p0_bp, source) = match req.prior {
        Some(p) => ((p * BP as f64).round() as i128, priors::OVERRIDE_SOURCE),
        None => (
            priors::prior_bp(&req.reason, req.evidence_on_file) as i128,
            priors::SOURCE,
        ),
    };
    let n = req.precedents.len() as i128;
    let wins = req.precedents.iter().filter(|p| p.won).count() as i128;
    // p = (wins + k*p0)/(n + k), in basis points (rounded, used only for display).
    let denom = n + K;
    let p_num_bp = wins * BP + K * p0_bp; // p = p_num_bp / (denom * BP)
    let p_bp = div_round(p_num_bp, denom);

    let a = req.amount_cents as i128;
    let f = req.fee_if_lost_cents as i128;
    let c = req.handling_cost_cents as i128;
    let ev_accept = -a;
    // (1-p)(A+F) = (denom*BP - p_num_bp)(A+F) / (denom*BP)
    let loss = div_round((denom * BP - p_num_bp) * (a + f), denom * BP);
    let ev_fight = -loss - c;
    let margin = ev_fight - ev_accept;
    let call = if ev_fight > ev_accept {
        "fight"
    } else {
        "accept"
    };

    let (ev_accept, ev_fight, margin) = (ev_accept as i64, ev_fight as i64, margin as i64);
    let p_text = bp_text(p_bp);
    let q_text = bp_text(BP - p_bp);
    let terms = vec![
        format!(
            "p = (wins + k*p0)/(n + k) = ({wins} + {K}*{})/({n} + {K}) = {p_text}",
            bp_text(p0_bp)
        ),
        format!("EV accept = -A = {}", money(ev_accept)),
        format!(
            "EV fight = -(1-p)*(A+F) - c = -({q_text})*({}+{}) - {} = {}",
            plain(req.amount_cents),
            plain(req.fee_if_lost_cents),
            plain(req.handling_cost_cents),
            money(ev_fight)
        ),
        format!(
            "fight - accept = p*A - (1-p)*F - c = {} -> {call}{}",
            signed_money(margin),
            if margin.abs() < MARGINAL_CENTS {
                " (marginal)"
            } else {
                ""
            }
        ),
    ];
    Response {
        contract: CONTRACT,
        p0: p0_bp as f64 / BP as f64,
        p0_source: source,
        k: K as i64,
        wins: wins as i64,
        n: n as i64,
        p: p_bp as f64 / BP as f64,
        ev_accept_cents: ev_accept,
        ev_fight_cents: ev_fight,
        margin_cents: margin,
        marginal: margin.abs() < MARGINAL_CENTS,
        call,
        terms,
    }
}
