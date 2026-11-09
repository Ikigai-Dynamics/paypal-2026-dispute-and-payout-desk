// Shapes the case page components take; the hook (item 2) fills them from /api.
export type AddedEvidence = {
  item: string;
  evidence_type: string;
  notes: string;
  tracking?: { carrier: string; number: string };
  file?: { name: string; content_type: string; data_base64: string };
};

export type Claim = {
  sentence: string;
  reason?: string;
  kind?: string;
  ok: boolean;
};

export type ChecklistItem = {
  item: string;
  required: boolean;
  status: "present" | "missing";
  why: string;
  suggestion?: { label: string; note: string };
};
