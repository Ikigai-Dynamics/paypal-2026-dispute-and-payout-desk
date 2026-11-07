# End-to-end run against a deployed cluster: nix run .#e2e
# Creates two exact scenarios in the mock, syncs the desk, reads the decisions and the
# drafted responses, then submits evidence on one case and accepts the other.
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
