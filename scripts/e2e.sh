# End-to-end run against a deployed cluster: nix run .#e2e
# Creates two exact scenarios in the mock, syncs the desk, reads the decisions and the
# drafted responses, then submits evidence on one case and accepts the other.
PORT_HTTP="${E2E_HTTP_PORT:-18080}"
H="desk.dispute-and-payout-desk.localhost:${PORT_HTTP}"
M="paypal-mock.dispute-and-payout-desk.localhost:${PORT_HTTP}"
HN="${H%%:*}"
MN="${M%%:*}"

desk() { curl -fsS --resolve "${HN}:${PORT_HTTP}:127.0.0.1" "$@"; }
mock() { curl -fsS --resolve "${MN}:${PORT_HTTP}:127.0.0.1" "$@"; }
fail() {
  echo "E2E FAILED: $*" >&2
  exit 1
}
assert() { # assert <description> <jq-filter-or-test result>
  if [ "$2" = "true" ]; then echo "  ok: $1"; else fail "$1 (got: $2)"; fi
}

echo "== waiting for the desk to be ready (up to 120 s)"
ready=false
for _ in $(seq 1 60); do
  if desk -o /dev/null "http://${H}/readyz" 2>/dev/null; then
    ready=true
    break
  fi
  sleep 2
done
[ "$ready" = true ] || fail "desk not ready after 120 s"

echo "== reset the mock and create two exact scenarios"
mock -X POST -H 'content-type: application/json' -d '{"seed":7}' "http://${M}/mock/reset" >/dev/null
mock -X POST -H 'content-type: application/json' "http://${M}/mock/disputes" -d '{
  "dispute_id": "PP-D-E2E-FIGHT",
  "reason": "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  "amount": "120.00",
  "stage": "INQUIRY",
  "due_in_days": 5,
  "buyer_name": "Rowan Fieldstone",
  "messages": ["My hardware kit never arrived. Where is my order?"],
  "items": [{"item_description": "Hardware kit #4417", "item_quantity": 1}],
  "evidences": [{
    "evidence_type": "PROOF_OF_FULFILLMENT",
    "evidence_info": {"tracking_info": [{"carrier_name": "UPS", "tracking_number": "1Z999AA10123456784"}]},
    "notes": "Shipped with tracking; delivery confirmation on file."
  }]
}' >/dev/null
mock -X POST -H 'content-type: application/json' "http://${M}/mock/disputes" -d '{
  "dispute_id": "PP-D-E2E-ACCEPT",
  "reason": "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
  "amount": "9.00",
  "stage": "INQUIRY",
  "due_in_days": 3,
  "buyer_name": "Casey Marlow",
  "messages": ["The download is not what the listing described."],
  "items": [{"item_description": "Digital download", "item_quantity": 1}]
}' >/dev/null

echo "== sync the desk from PayPal"
desk -X POST "http://${H}/api/sync" | jq -c .

echo "== both scenarios are in the case list"
cases=$(desk "http://${H}/api/cases")
assert "PP-D-E2E-FIGHT listed" "$(echo "$cases" | jq '[.cases[].dispute_id] | index("PP-D-E2E-FIGHT") != null')"
assert "PP-D-E2E-ACCEPT listed" "$(echo "$cases" | jq '[.cases[].dispute_id] | index("PP-D-E2E-ACCEPT") != null')"

echo "== Postgres full-text search for 'tracking'"
hits=$(desk "http://${H}/api/search?q=tracking")
echo "$hits" | jq -c '{engine, hits: (.hits | length), first: .hits[0].dispute_id}'
assert "at least one hit" "$(echo "$hits" | jq '(.hits | length) >= 1')"

show() { # show <label> <analysis-json>
  echo "-- $1"
  echo "decision terms:"
  echo "$2" | jq -r '.decision.terms[] | "  " + .'
  echo "call: $(echo "$2" | jq -r '.decision.call') (margin $(echo "$2" | jq -r '.decision.margin_cents') cents, marginal $(echo "$2" | jq -r '.decision.marginal'))"
  echo "precedents: $(echo "$2" | jq -r '.precedents | length') (won $(echo "$2" | jq -r '[.precedents[] | select(.won)] | length'))"
  echo "draft source: $(echo "$2" | jq -r '.draft.source') $(echo "$2" | jq -r '.draft.model // ""')"
  echo "draft response:"
  echo "$2" | jq -r '.draft.response' | fold -s -w 100 | sed 's/^/  /'
  echo "checklist:"
  echo "$2" | jq -r '.draft.checklist[] | "  [" + .status + "] " + .item'
}

echo "== analysis: the fight case"
fight=$(desk "http://${H}/api/cases/PP-D-E2E-FIGHT/analysis")
show "PP-D-E2E-FIGHT" "$fight"
assert "call is fight" "$(echo "$fight" | jq '.decision.call == "fight"')"
assert "draft cites the tracking number on file" "$(echo "$fight" | jq '.draft.response | contains("1Z999AA10123456784")')"

echo "== analysis: the accept case"
acc=$(desk "http://${H}/api/cases/PP-D-E2E-ACCEPT/analysis")
show "PP-D-E2E-ACCEPT" "$acc"
assert "call is accept" "$(echo "$acc" | jq '.decision.call == "accept"')"
assert "no tracking number invented" "$(echo "$acc" | jq '(.draft.response | test("[0-9][A-Z0-9]{9,}")) | not')"

echo "== changing c from 15.00 to 2.00 flips the 9 dollar case to fight"
low=$(desk "http://${H}/api/cases/PP-D-E2E-ACCEPT/analysis?c=2")
echo "$low" | jq -r '.decision.terms[]' | sed 's/^/  /'
assert "call flips to fight" "$(echo "$low" | jq '.decision.call == "fight"')"

echo "== writes need confirm: true"
code=$(curl -s --resolve "${HN}:${PORT_HTTP}:127.0.0.1" -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -d '{"text":"no confirm"}' "http://${H}/api/cases/PP-D-E2E-FIGHT/evidence")
assert "write without confirm returns 400" "$([ "$code" = 400 ] && echo true || echo "$code")"

echo "== submit evidence on the fight case"
text=$(echo "$fight" | jq -r '.draft.response')
res=$(desk -X POST -H 'content-type: application/json' \
  -d "$(jq -n --arg t "$text" '{text: $t, confirm: true}')" "http://${H}/api/cases/PP-D-E2E-FIGHT/evidence")
echo "$res" | jq -c '.case | {dispute_id, status}'
assert "status is UNDER_REVIEW" "$(echo "$res" | jq '.case.status == "UNDER_REVIEW"')"

echo "== accept the claim on the accept case"
res=$(desk -X POST -H 'content-type: application/json' \
  -d '{"note":"Accepted from the e2e run","confirm":true}' "http://${H}/api/cases/PP-D-E2E-ACCEPT/accept")
echo "$res" | jq -c '.case | {dispute_id, status, outcome}'
assert "resolved in the buyer's favour" "$(echo "$res" | jq '.case.status == "RESOLVED" and .case.outcome == "RESOLVED_BUYER_FAVOUR"')"

echo "== the mock agrees"
st=$(desk "http://${H}/api/info")
echo "$st" | jq -c '{paypalEnv, llm, cases, decide}'
assert "mock is the PayPal environment" "$(echo "$st" | jq '.paypalEnv == "mock"')"

echo "E2E OK"
