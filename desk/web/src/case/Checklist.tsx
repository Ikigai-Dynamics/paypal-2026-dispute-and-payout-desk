import React, { useState } from "react";
import type { AddedEvidence, ChecklistItem } from "./types";

export const evType = (item: string) =>
  /tracking|delivery|email log|code sent|fulfil/i.test(item)
    ? "PROOF_OF_FULFILLMENT"
    : /refund/i.test(item)
      ? "PROOF_OF_REFUND"
      : "OTHER";

const MAX_FILE = 5 * 1024 * 1024;
const FILE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
};
const readFile = (f: File) =>
  new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1] ?? "");
    fr.onerror = rej;
    fr.readAsDataURL(f);
  });

export type ChecklistProps = {
  items: ChecklistItem[];
  added: Map<string, AddedEvidence>;
  onAdd(ev: AddedEvidence): void;
  onUndo(item: string): void;
};

const required = (i: ChecklistItem) => i.required !== false; // old servers send no flag

function AddForm({ item, onAdd, onCancel }: { item: string; onAdd(ev: AddedEvidence): void; onCancel(): void }) {
  const [err, setErr] = useState("");
  const tracking = item === "Tracking number";
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const evidence_type = evType(item);
    let ev: AddedEvidence;
    if (tracking) {
      const carrier = String(f.get("carrier")).trim();
      const number = String(f.get("number")).trim();
      ev = { item, evidence_type, notes: `${carrier} tracking ${number}`, tracking: { carrier, number } };
    } else {
      ev = { item, evidence_type, notes: String(f.get("note")).trim() };
      const file = f.get("file");
      if (file instanceof File && file.size) {
        const ct = FILE_TYPES[file.name.split(".").pop()?.toLowerCase() ?? ""];
        if (!ct) return setErr("Use a .png, .jpg or .pdf file.");
        if (file.size > MAX_FILE) return setErr("That file is over 5 MB.");
        ev.file = { name: file.name, content_type: ct, data_base64: await readFile(file) };
      }
    }
    onAdd(ev);
  };
  return (
    <form onSubmit={submit}>
      {tracking ? (
        <div className="row">
          <label>
            Carrier<input name="carrier" required />
          </label>
          <label>
            Tracking number<input name="number" required />
          </label>
        </div>
      ) : (
        <>
          <label>
            Note
            <textarea name="note" rows={2} required placeholder="What happened, in your words" />
          </label>
          <label>
            File (optional, .png .jpg .pdf, up to 5 MB)
            <input type="file" name="file" accept=".png,.jpg,.jpeg,.pdf" />
          </label>
        </>
      )}
      {err && <div className="formerr">{err}</div>}
      <div className="row">
        <button className="primary">Save</button>
        <button type="button" className="cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Row({ i, ad, onAdd, onUndo }: { i: ChecklistItem; ad?: AddedEvidence; onAdd(ev: AddedEvidence): void; onUndo(item: string): void }) {
  const [form, setForm] = useState(false);
  const ok = i.status !== "missing";
  const sg = i.suggestion;
  const link = (text: string, fn: () => void) => (
    <a href="#" onClick={(e) => (e.preventDefault(), fn())}>
      {text}
    </a>
  );
  return (
    <li className={ok || ad ? "ok" : "no"}>
      <span className="ico">{ok || ad ? "✓" : "✗"}</span>
      <b>{i.item}</b>
      <span className={"pill " + (required(i) ? "amber" : "grey")}>{required(i) ? "Required" : "Optional"}</span>
      <span className="why" style={ad ? { color: "var(--green)" } : undefined}>
        {ad ? "Added, will be sent with your response" : i.why}
      </span>
      {ad
        ? link("Undo", () => onUndo(i.item))
        : !ok &&
          (form ? (
            <AddForm item={i.item} onAdd={onAdd} onCancel={() => setForm(false)} />
          ) : sg ? (
            <>
              <button type="button" className="primary" onClick={() => onAdd({ item: i.item, evidence_type: evType(i.item), notes: sg.note })}>
                {sg.label}
              </button>
              {link("Write your own", () => setForm(true))}
            </>
          ) : (
            <button type="button" onClick={() => setForm(true)}>
              Add
            </button>
          ))}
    </li>
  );
}

export function Checklist({ items, added, onAdd, onUndo }: ChecklistProps) {
  const miss = items.filter((i) => i.status === "missing" && required(i) && !added.has(i.item)).length;
  return (
    <>
      <h3>
        Evidence checklist{" "}
        {items.length > 0 && (
          <span className={"pill " + (miss ? "red" : "green")}>
            {miss ? `${miss} required item${miss === 1 ? "" : "s"} missing` : "Ready to submit"}
          </span>
        )}
      </h3>
      <ul className="checklist">
        {items.map((i) => (
          <Row key={i.item} i={i} ad={added.get(i.item)} onAdd={onAdd} onUndo={onUndo} />
        ))}
      </ul>
    </>
  );
}
