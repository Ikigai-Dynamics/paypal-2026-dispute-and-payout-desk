import { useEffect, useState } from "react";
import { api } from "../lib/api";
import "./trust.css";

const ENDPOINTS: { path: string; what: string; csv?: boolean }[] = [
  { path: "/api/cases", what: "Every dispute with Parley's call for each", csv: true },
  { path: "/api/activity", what: "Every PayPal call, Parley decision and human approval", csv: true },
  { path: "/api/assumptions", what: "The numbers behind Parley's calls, and where each comes from" },
  { path: "/api/cases/{id}/decision", what: "The question the desk asked the decision core for one case, and its answer" },
  { path: "/api/info", what: "Environment, AI, decision core and last sync" },
];

/** read-only API guide, shown in place of the desk at #developers */
export function DeveloperPage() {
  const [sample, setSample] = useState<string | null>(null);
  useEffect(() => {
    api<{ cases: { dispute_id: string }[] }>("/api/cases").then(
      (r) => setSample(r.cases[0]?.dispute_id ?? null),
      () => {},
    );
  }, []);
  return (
    <section className="card dev">
      <a className="chip" href="#">
        Back to the desk
      </a>
      <h2>Developers</h2>
      <p className="muted">
        Everything the desk shows is available as plain JSON. These endpoints only read; nothing here writes to PayPal.
      </p>
      <ul className="endpoints">
        {ENDPOINTS.map((e) => {
          const href = e.path.replace("{id}", sample ?? "");
          return (
            <li key={e.path}>
              <code>GET {e.path}</code>
              <span>{e.what}</span>
              <span className="links">
                {sample || !e.path.includes("{id}") ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    Try it
                  </a>
                ) : null}
                {e.csv && (
                  <a href={`${e.path}?format=csv`} download>
                    ?format=csv
                  </a>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <p>
        <a href="/api/openapi.json" target="_blank" rel="noreferrer">
          OpenAPI description (JSON)
        </a>{" "}
        · includes the PayPal webhook receiver
      </p>
    </section>
  );
}
