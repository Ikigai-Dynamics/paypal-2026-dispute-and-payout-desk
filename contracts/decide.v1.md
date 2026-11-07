# Contract decide.v1

Served by the Rust service `decide` (port 8080, Service `http://decide`). Golden cases for both implementations and
their tests: `fixtures/decide.v1.cases.json` (copies in `decide/fixtures/` and `desk/test/fixtures/`, kept identical by
a flake check).

- `GET /healthz`, `GET /readyz`: `ok`.
- `POST /v1/decide`: 200 with the response below; 400 `{error, detail}` when `contract` is not `decide.v1` or an amount
  is negative or `prior` is outside 0..1.
- SIGTERM drains in-flight requests and exits.

## Request

```json
{ "contract": "decide.v1",
  "amount_cents": 12000, "currency": "USD", "reason": "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  "stage": "INQUIRY", "evidence_on_file": true,
  "prior": null,
  "handling_cost_cents": 1500,
  "fee_if_lost_cents": 0,
  "precedents": [ { "dispute_id": "PP-D-1", "won": true }, { "dispute_id": "PP-D-2", "won": false } ] }
```

`prior` (optional) overrides p0. `precedents` are resolved similar cases; `won` means the seller won.

## Response

```json
{ "contract": "decide.v1",
  "p0": 0.55, "p0_source": "prior supplied in the request",
  "k": 4, "wins": 3, "n": 4, "p": 0.65,
  "ev_accept_cents": -12000, "ev_fight_cents": -5700,
  "margin_cents": 6300, "marginal": false, "call": "fight",
  "terms": [
    "p = (wins + k*p0)/(n + k) = (3 + 4*0.55)/(4 + 4) = 0.65",
    "EV accept = -A = -$120.00",
    "EV fight = -(1-p)*(A+F) - c = -(0.35)*(120.00+0.00) - 15.00 = -$57.00",
    "fight - accept = p*A - (1-p)*F - c = +$63.00 -> fight" ] }
```

## Rules

- `p = (wins + k*p0)/(n + k)`, `k = 4`.
- `ev_accept = -A`; `ev_fight = -(1-p)(A+F) - c`.
- `call` is `fight` when `ev_fight > ev_accept`, otherwise `accept`. `marginal` is true when `|margin| < $5.00`.
- Integer cents throughout, rounded half away from zero. Probabilities are held in basis points internally, so p0 is
  taken to 4 decimals.
- When `prior` is absent, p0 comes from the table in `decide/src/priors.rs` (an assumption, labelled in `p0_source`):
  not received 0.45 (0.60 with evidence), not as described 0.35 (0.45 with evidence), unauthorised 0.25, duplicate
  transaction and credit not processed 0.30, cancelled recurring billing 0.40, anything else 0.35.
