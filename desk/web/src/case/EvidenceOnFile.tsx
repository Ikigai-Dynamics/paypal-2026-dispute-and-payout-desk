import type { AddedEvidence, Analysis, Evidence } from "../lib/api";
import { dateShort } from "../lib/format";

type Row = {
  item?: string;
  notes?: string;
  evidence_info?: Evidence["evidence_info"];
};
const trim = (n: unknown) => String(n ?? "").trim();

export function EvidenceOnFile({
  analysis: a,
  onFile,
  sentEvidence,
  vouched,
  added,
  sentText,
  sent,
}: {
  analysis: Analysis;
  /** evidences on file, minus the one that is the sent response text */
  onFile: Evidence[];
  sentEvidence: AddedEvidence[];
  vouched: string[];
  added: Map<string, AddedEvidence>;
  sentText: string | null;
  sent: boolean;
}) {
  const row = (e: Row, mine: boolean, key: string) => {
    const t = (e.evidence_info?.tracking_info ?? [])
      .map((x) => `${x.carrier_name} ${x.tracking_number}`)
      .join(", ");
    const lead = mine ? e.item : t || e.item;
    return (
      <div className="msg" key={key}>
        {lead ? <b>{lead} </b> : null}
        {e.notes ?? ""}
        {mine && (
          <div className="muted mine">
            Added by you · will be sent with your response
          </div>
        )}
      </div>
    );
  };
  const have = new Set(onFile.map((e) => trim(e.notes)));
  const sentRows = sentEvidence.filter((e) => !have.has(trim(e.notes)));
  const commOk = a.draft.checklist.some(
    (i) => i.item === "Communication with the buyer" && i.status !== "missing",
  );
  const mine = !commOk
    ? []
    : a.case.messages
        .filter(
          (m) =>
            m.posted_by !== "BUYER" && !m.content.includes(sentText ?? "\0"),
        )
        .map((m, i) => {
          let t = m.content.trim();
          if (t.length > 140) t = t.slice(0, 140).replace(/\s+\S*$/, "") + "…";
          const d = m.time_posted ? dateShort(m.time_posted) : "";
          return (
            <div className="msg" key={`m${i}`}>
              <b>Your message to the buyer</b>
              {d ? ` (${d})` : ""} {t}
            </div>
          );
        });
  const rows = [
    ...onFile.map((e, i) => row(e, false, `f${i}`)),
    ...sentRows.map((e, i) => row(e, false, `s${i}`)),
    ...vouched.map((v, i) => (
      <div className="msg" key={`v${i}`}>
        <b>Your statement:</b> {v}
      </div>
    )),
    ...[...added.values()].map((e) => row(e, true, `a${e.item}`)),
    ...mine,
  ];
  return (
    <>
      <h3 id="evidence-h">
        {sent || a.case.status === "UNDER_REVIEW"
          ? "Evidence sent"
          : "Evidence on file"}
      </h3>
      <div id="evidence">
        {rows.length ? rows : <p className="muted">Nothing yet</p>}
      </div>
    </>
  );
}
export default EvidenceOnFile;
