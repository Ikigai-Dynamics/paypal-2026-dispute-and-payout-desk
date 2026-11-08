# Shared by e2e and demo-reset (concatenated by nix/project.nix): helpers, then reset the mock,
# create the two named scenarios and sync the desk.
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
  "due_in_days": 2,
  "buyer_name": "Rowan Fieldstone",
  "messages": ["My hardware kit never arrived. Where is my order?"],
  "items": [{"item_description": "Hardware kit #4417", "item_quantity": 1}],
  "evidences": [{
    "evidence_type": "PROOF_OF_FULFILLMENT",
    "evidence_info": {"tracking_info": [{"carrier_name": "UPS", "tracking_number": "1Z999AA10123456784"}]},
    "notes": "Shipped with UPS tracking."
  }]
}' >/dev/null
mock -X POST -H 'content-type: application/json' "http://${M}/mock/disputes" -d '{
  "dispute_id": "PP-D-E2E-ACCEPT",
  "reason": "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
  "amount": "9.00",
  "stage": "INQUIRY",
  "due_in_days": 4,
  "buyer_name": "Casey Marlow",
  "messages": ["The download is not what the listing described."],
  "items": [{"item_description": "Digital download", "item_quantity": 1}]
}' >/dev/null

echo "== sync the desk from PayPal"
desk -X POST "http://${H}/api/sync" | jq -c .
