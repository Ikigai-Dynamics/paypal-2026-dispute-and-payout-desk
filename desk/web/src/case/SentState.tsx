/** The response that went to PayPal, once sent (or found on file as the hidden OTHER evidence). */
export function SentState({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div id="sent-block">
      <h3>Your response</h3>
      <div className="sent">{text}</div>
    </div>
  );
}
export default SentState;
