# End-to-end run against a deployed cluster: nix run .#e2e
# Reloads the shared dataset into the mock, syncs the desk, reads the decisions and the
# drafted responses, then submits evidence on one case and accepts another.
echo "== the React build is what is served"
page=$(curl -s --resolve "${HN}:${PORT_HTTP}:127.0.0.1" "http://${H}/")
assert "GET / has the React root" "$(echo "$page" | grep -q '<div id="root">' && echo true || echo false)"
assert "no vendor script" "$(echo "$page" | grep -q '/vendor/' && echo false || echo true)"
ct=$(curl -s --resolve "${HN}:${PORT_HTTP}:127.0.0.1" -o /dev/null -w '%{content_type}' "http://${H}/app.js")
assert "GET /app.js is JavaScript" "$(echo "$ct" | grep -qi javascript && echo true || echo "$ct")"
vc=$(curl -s --resolve "${HN}:${PORT_HTTP}:127.0.0.1" -o /dev/null -w '%{http_code}' "http://${H}/vendor/ag-grid-community.min.js")
assert "the old vendor route is gone without a 500" "$([ "$vc" -lt 500 ] && echo true || echo "$vc")"

echo "== the shared dataset is listed"
cases=$(desk "http://${H}/api/cases")
assert "60 cases" "$(echo "$cases" | jq '(.cases | length) == 60')"
for id in PP-D-GIFTCARD-0001 PP-D-BIGCHARGEBACK-0002 PP-D-DUPLICATE-0003; do
  assert "$id listed" "$(echo "$cases" | jq --arg id "$id" '[.cases[].dispute_id] | index($id) != null')"
done

assert "summary buckets add up to the total" "$(desk "http://${H}/api/cases" | jq '.summary | (.needs_response + .under_review + .closed + .missed_deadline + .waiting_on_buyer + .other) == .total')"

echo "== Postgres full-text search for 'tracking'"
hits=$(desk "http://${H}/api/search?q=tracking")
echo "$hits" | jq -c '{engine, hits: (.hits | length), first: .hits[0].dispute_id}'
assert "at least one hit" "$(echo "$hits" | jq '(.hits | length) >= 1')"

show() { # show <label> <analysis-json>
  echo "-- $1"
  echo "decision terms:"
  echo "$2" | jq -r '.decision.terms[] | "  " + .'
  echo "call: $(echo "$2" | jq -r '.decision.call') (margin $(echo "$2" | jq -r '.decision.margin_cents') cents, marginal $(echo "$2" | jq -r '.decision.marginal'))"
  echo "$2" | jq -r '.decision | "win chance (estimated): \(.p * 100 | round)% (\(.p_lo * 100 | round)-\(.p_hi * 100 | round)%), keeps \(.keep_cents) cents, AI cost \(.ai_cost_cents) cents, core \(.core_version)"'
  echo "$2" | jq -r '.decision | if .offer then "best offer: \(.offer.amount_cents) cents (buyer accepts about \(.offer.q * 100 | round)%, EV \(.offer.ev_cents))\(if .call == "offer" then " <- the call" else "" end)" else "no offer possible" end'
  echo "precedents: $(echo "$2" | jq -r '.precedents | length') (won $(echo "$2" | jq -r '[.precedents[] | select(.won)] | length'))"
  echo "draft source: $(echo "$2" | jq -r '.draft.source') $(echo "$2" | jq -r '.draft.model // ""')"
  echo "draft response:"
  echo "$2" | jq -r '.draft.response' | fold -s -w 100 | sed 's/^/  /'
  echo "checklist:"
  echo "$2" | jq -r '.draft.checklist[] | "  [" + .status + "] " + .item'
}

FIGHT=PP-D-BIGCHARGEBACK-0002
ACCEPT=PP-D-DUPLICATE-0003
echo "== analysis: the large chargeback (Marcus Bell, USD 1,317; recommended fight)"
fight=$(desk "http://${H}/api/cases/${FIGHT}/analysis")
show "$FIGHT" "$fight"
assert "call is fight or offer" "$(echo "$fight" | jq '.decision.call == "fight" or .decision.call == "offer"')"
assert "decision is decide.v2 with a range" "$(echo "$fight" | jq '.decision.contract == "decide.v2" and .decision.p_lo < .decision.p and .decision.p < .decision.p_hi')"
# a billing address is not an address match, so that item stays missing
assert "checklist: the address item is missing" "$(echo "$fight" | jq '[.draft.checklist[] | select(.status == "missing") | .item] | index("Shipping address matches the buyer") != null')"
assert "explanation is plain English" "$(echo "$fight" | jq '.draft.explanation | test("p =|EV") | not')"
assert "draft is non-empty" "$(echo "$fight" | jq '.draft.response | length > 40')"
assert "draft names the buyer exactly as on file" "$(echo "$fight" | jq '.draft.response | contains("Marcus Bell")')"
assert "draft states the amount exactly as on file" "$(echo "$fight" | jq '.draft.response | test("1,?317")')"
assert "draft never says 'record shows'" "$(echo "$fight" | jq '.draft.response | test("record shows"; "i") | not')"
assert "response names no dispute id" "$(echo "$fight" | jq '.draft.response | contains("PP-D-") | not')"

echo "== the case 'Fight the most urgent dispute' opens"
urgent=$(desk "http://${H}/api/cases" | jq -r '[.cases[] | select((.status == "WAITING_FOR_SELLER_RESPONSE" or .status == "OPEN") and ((.call // "") | test("^(fight|offer)")) and .due_at != null and ((.due_at | sub("\\.[0-9]+"; "") | fromdateiso8601) > now))] | sort_by(.due_at) | .[0] | "\(.buyer)|\(.dispute_id)"')
echo "urgent fight case: ${urgent%%|*} (${urgent##*|})"
assert "an urgent fight case has a buyer name" "$([ -n "${urgent%%|*}" ] && [ "${urgent%%|*}" != null ] && echo true || echo false)"

echo "== analysis: the accept case (Priya Nair, USD 164)"
acc=$(desk "http://${H}/api/cases/${ACCEPT}/analysis")
show "$ACCEPT" "$acc"
assert "a call is made" "$(echo "$acc" | jq '.decision.call == "fight" or .decision.call == "accept" or .decision.call == "offer"')"
assert "no tracking number invented" "$(echo "$acc" | jq '(.draft.response | test("[0-9][A-Z0-9]{9,}")) | not')"

echo "== changing the cost to fight (c) to 0.01 never makes accept more likely"
low=$(desk "http://${H}/api/cases/${ACCEPT}/analysis?c=0.01")
echo "$low" | jq -r '.decision.terms[]' | sed 's/^/  /'
assert "margin does not fall" "$(jq -n --argjson a "$acc" --argjson l "$low" '$l.decision.margin_cents >= $a.decision.margin_cents')"

echo "== writes need confirm: true"
code=$(curl -s --resolve "${HN}:${PORT_HTTP}:127.0.0.1" -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -d '{"text":"no confirm"}' "http://${H}/api/cases/PP-D-BIGCHARGEBACK-0002/evidence")
assert "write without confirm returns 400" "$([ "$code" = 400 ] && echo true || echo "$code")"

echo "== submit evidence on the fight case (provide-evidence returns 200)"
text=$(echo "$fight" | jq -r '.draft.response')
res=$(desk -X POST -H 'content-type: application/json' \
  -d "$(jq -n --arg t "$text" '{text: $t, confirm: true}')" "http://${H}/api/cases/${FIGHT}/evidence")
echo "$res" | jq -c '.case | {dispute_id, status}'
assert "status is UNDER_REVIEW" "$(echo "$res" | jq '.case.status == "UNDER_REVIEW"')"

echo "== accept the claim on the accept case"
res=$(desk -X POST -H 'content-type: application/json' \
  -d '{"note":"Accepted from the e2e run","confirm":true}' "http://${H}/api/cases/${ACCEPT}/accept")
echo "$res" | jq -c '.case | {dispute_id, status, outcome}'
assert "resolved in the buyer's favour" "$(echo "$res" | jq '.case.status == "RESOLVED" and .case.outcome == "RESOLVED_BUYER_FAVOUR"')"

echo "== the mock agrees"
st=$(desk "http://${H}/api/info")
echo "$st" | jq -c '{paypalEnv, llm, cases, decide}'
assert "mock is the PayPal environment" "$(echo "$st" | jq '.paypalEnv == "mock"')"

echo "== the invented-fact check"
SENT='UPS tracking 1Z999AA10123456784 shows the order was delivered Oct 30.'
code=$(curl -s -o /dev/null -w '%{http_code}' --resolve "${HN}:${PORT_HTTP}:127.0.0.1" -X POST -H 'content-type: application/json' \
  -d "$(jq -n --arg s "$SENT" '{confirm:true,text:("We shipped it. "+$s)}')" "http://${H}/api/cases/PP-D-GIFTCARD-0001/evidence")
assert "unsupported shipping claim is refused with 422" "$([ "$code" = 422 ] && echo true || echo "$code")"

echo "== evidence added on the page survives a reload and sends (Sofia Lindqvist)"
GC=PP-D-GIFTCARD-0001
ADDED='[{"item":"Email log","evidence_type":"PROOF_OF_FULFILLMENT","notes":"Gift card code emailed to the buyer on Oct 28."}]'
put=$(desk -X PUT -H 'content-type: application/json' \
  -d "$(jq -n --argjson a "$ADDED" '{added:$a}')" "http://${H}/api/cases/${GC}/work")
assert "PUT /work accepts the page's payload" "$(echo "$put" | jq '.work.added[0].evidence_type == "PROOF_OF_FULFILLMENT"')"
reload=$(desk "http://${H}/api/cases/${GC}/analysis")
assert "a reload returns the saved evidence" "$(echo "$reload" | jq '.work.added | length == 1')"
OWN='The gift card code was emailed to the buyer; the email log is attached.'
dry=$(desk -X POST -H 'content-type: application/json' \
  -d "$(jq -n --arg s "$OWN" '{text:$s}')" "http://${H}/api/cases/${GC}/check")
assert "dry run flags only the sentence the merchant wrote, as added" "$(echo "$dry" | jq --arg s "$OWN" '.sentences == [.sentences[0]] and .sentences[0].sentence == $s and .sentences[0].kind == "added"')"
dry=$(desk -X POST -H 'content-type: application/json' \
  -d "$(jq -n --arg s "$OWN" '{text:$s, attested:[$s]}')" "http://${H}/api/cases/${GC}/check")
assert "dry run finds nothing invented once the sentence is attested" "$(echo "$dry" | jq '.sentences | length == 0')"
res=$(desk -X POST -H 'content-type: application/json' \
  -d "$(jq -n --arg s "$OWN" '{text:$s, attested:[$s], confirm:true}')" "http://${H}/api/cases/${GC}/evidence")
assert "send with the saved evidence is UNDER_REVIEW" "$(echo "$res" | jq '.case.status == "UNDER_REVIEW"')"
sent=$(desk "http://${H}/api/cases/${GC}/analysis")
assert "the sent record lists the evidence" "$(echo "$sent" | jq '.sent.added | length == 1')"

echo "== leave the demo clean for the next viewer"
reset_demo

echo "E2E OK"
