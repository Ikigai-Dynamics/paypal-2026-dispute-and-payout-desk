# Shared by e2e and demo-reset (concatenated by nix/project.nix): helpers, then reset the mock,
# reload the shared dataset and sync the desk.
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

echo "== reset the mock to the shared dataset (Ikigai Outfitters)"
mock -X POST -H 'content-type: application/json' -d '{}' "http://${M}/mock/reset" >/dev/null

echo "== sync the desk from PayPal"
desk -X POST "http://${H}/api/sync" | jq -c .
