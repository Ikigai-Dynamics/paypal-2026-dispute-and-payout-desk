# Run right after every deploy. Reseed the demo from the shared dataset: the narrated cases are open and synced.
# the chat memory starts empty (conversations have no delete route)
for id in $(desk "http://${H}/api/chat/memory" | jq -r '.memory[].id'); do
  desk -X DELETE "http://${H}/api/chat/memory/${id}" >/dev/null
done
echo "demo ready (nix run .#demo-reset), open cases the landing page lists, most urgent first:"
desk "http://${H}/api/cases" | jq -r '[.cases[] | select(.status == "WAITING_FOR_SELLER_RESPONSE" or .status == "OPEN")] | sort_by(.days_left)[:8][] | "  \(.buyer), \(.currency) \(.amount_cents / 100) (\(.dispute_id)), \(.call)"'
