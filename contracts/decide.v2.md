# Contract decide.v2

Served by the Rust service `decide` (port 8080, Service `http://decide`). Golden cases for both implementations and
their tests: `fixtures/decide.v2.cases.json` (copies in `decide/fixtures/` and `desk/test/fixtures/`, kept identical by
a flake check). v1 is gone; the desk is the only caller.

- `GET /healthz`, `GET /readyz`: `ok`.
- `POST /v2/decide`: 200 with the response below; 400 `{error, detail}` when `contract` is not `decide.v2`, an amount
  or cost is negative, or `prior` is outside 0..1.
- `GET /v2/assumptions`: `{version, assumptions: [{id, label, value, unit, source}]}`, the defaults the core runs on
  (the prior table, K, the acceptance curve, the offer step, the minimum gain, default handling cost).
- SIGTERM drains in-flight requests and exits.

## Request

```json
{ "contract": "decide.v2",
  "amount_cents": 12000, "currency": "USD", "reason": "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  "stage": "INQUIRY", "evidence_on_file": true,
  "prior": null,
  "handling_cost_cents": 1500, "ai_cost_cents": 25,
  "fee_if_lost_cents": 0,
  "precedents": [ { "dispute_id": "PP-D-1", "won": true }, { "dispute_id": "PP-D-2", "won": false } ] }
```

`prior` (optional) overrides p0. `precedents` are resolved similar cases; `won` means the seller won.
`ai_cost_cents` (default 0) is what the AI drafting of this case cost; it is added to the fight cost.
`buyer_orders` and `buyer_disputes` (optional, u32, default 0) are the orders this buyer has placed with the seller and
the disputes they opened, this one included. Old requests without them still parse.

## Response

`contract`, `core_version` (crate version), `assumptions_version`, `p0`, `p0_source`, `k`, `wins`, `n`, `p`, `p_lo`,
`p_hi`, `ai_cost_cents`, `fight_cost_cents`, `ev_accept_cents`, `ev_fight_cents`, `ev_offer_cents` (or null), `offer`
(`{amount_cents, q, ev_cents}` or null), `margin_cents`, `marginal`, `call`, `keep_cents`, `buyer_flag`
(true for a repeat disputer, see below), `buyer_orders` and `buyer_disputes` (the request values, orders never below disputes), `assumptions`
(`[{id, label, value, unit, source}]` used for this decision) and `terms` (plain-language sentences).

`offer` is the best partial refund found, whether or not it is the call; it is null when the amount is under $1.00 or
when no offer is allowed (below). `label` is the plain-language name of an assumption for screens; `source` never names
a file.

## Rules

- Win chance: the posterior is Beta(a, b) with a = wins + K*p0, b = (n - wins) + K*(1 - p0), K = 4. `p` is its mean,
  (wins + K*p0)/(n + K), held in basis points. `p_lo` and `p_hi` are its 10th and 90th percentiles (an 80% range),
  to 4 decimals. All of these are estimated, not PayPal data.
- Fight cost `c = handling_cost_cents + ai_cost_cents`.
- `ev_accept = -A`; `ev_fight = -(1-p)(A+F) - c`; `margin_cents = ev_fight - ev_accept`; `marginal` when
  `|margin| < $5.00`.
- Offer scan: buyers accept an offer x with probability `q(x) = 1/(1+exp(-s*(x/A - m)))`, m = 0.5, s = 8 (estimated).
  `ev_offer(x) = q(x)*(-x) + (1-q(x))*ev_fight`. x runs from 50 cents to A-50 cents in 50-cent steps; the x with the
  highest EV (lowest x on a tie) is `offer`.
- `call`: `fight` when `ev_fight > ev_accept`, otherwise `accept`, unless the best offer's EV is strictly greater than
  both and beats the better of them by at least $5.00 (`offer_min_gain`), then `offer`.
- `keep_cents` = A plus the EV of the chosen call (0 for accept).
- No offer (`offer` null, never the call) when: the reason is `UNAUTHORISED` (PayPal's offer flow does not apply; the
  call is fight or accept); the reason is `DUPLICATE_TRANSACTION` or `CREDIT_NOT_PROCESSED` with `evidence_on_file`
  false (the call is then always `accept`: a real duplicate is refunded in full); or the buyer is a repeat disputer.
- Repeat disputer: `buyer_disputes >= 7` (`serial_min_disputes`, an estimate) and `buyer_disputes*2 >= buyer_orders`.
  `buyer_flag` is true, p0 moves up by 10 points (capped at 0.9) because a pattern of disputes is evidence for the
  seller, and a term says so.
- Integer cents throughout, rounded half away from zero. p0 is taken to 4 decimals.
- When `prior` is absent, p0 comes from the table in `decide/src/priors.rs` (served by `/v2/assumptions`).
