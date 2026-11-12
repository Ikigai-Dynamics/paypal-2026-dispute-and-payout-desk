//! Assumed prior win probability p0 per dispute reason. An assumption, not PayPal data.

pub const SOURCE: &str = "assumed prior for reason (table in decide/src/priors.rs)";
pub const OVERRIDE_SOURCE: &str = "prior supplied in the request";

/// p0 in basis points of one (0..=10000).
pub fn prior_bp(reason: &str, evidence_on_file: bool) -> u32 {
    match (reason, evidence_on_file) {
        ("MERCHANDISE_OR_SERVICE_NOT_RECEIVED", true) => 6000,
        ("MERCHANDISE_OR_SERVICE_NOT_RECEIVED", false) => 4500,
        ("MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", true) => 4500,
        ("MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", false) => 3500,
        ("UNAUTHORISED", _) => 2500,
        // The buyer is almost always right and the seller has nothing on file.
        ("DUPLICATE_TRANSACTION", false) => 500,
        ("CREDIT_NOT_PROCESSED", false) => 800,
        ("DUPLICATE_TRANSACTION", true) | ("CREDIT_NOT_PROCESSED", true) => 3000,
        ("CANCELED_RECURRING_BILLING", _) => 4000,
        _ => 3500,
    }
}

/// Reasons with their own entry in the table (anything else uses the default entry).
pub const REASONS: [&str; 6] = [
    "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    "UNAUTHORISED",
    "DUPLICATE_TRANSACTION",
    "CREDIT_NOT_PROCESSED",
    "CANCELED_RECURRING_BILLING",
];
