"use client";
import { useState, useTransition } from "react";
import type { TryOutcome, TryResult } from "../server/try.ts";
import { tryEmail } from "./actions.ts";
import { Marked } from "./Bits.tsx";

/** "Show as" wording from FRONTEND_CONTRACT.md ("Try any email"). Never worded as a credit. */
const OUTCOME_WORDS: Record<TryOutcome, string> = {
  held_at_intake: "Held when the email came in",
  will_hold_dispute: "Will be held: dispute noted in the email",
  needs_link: "PM must choose the subcontract",
  ready_for_notice: "Ready for a notice to the sub",
};
const OUTCOME_TONE: Record<TryOutcome, string> = { held_at_intake: "danger", will_hold_dispute: "warn", needs_link: "warn", ready_for_notice: "ok" };

export function TryPanel() {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();
  // The exact body that was sent: highlight offsets index this string, not whatever is in the box now.
  const [shown, setShown] = useState<{ sent: string; result: TryResult } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = () =>
    start(async () => {
      const sent = body;
      setError(null);
      const r = await tryEmail({ subject, body: sent });
      if (r.ok) setShown({ sent, result: r.result });
      else {
        setShown(null);
        setError(r.error);
      }
    });

  return (
    <>
      <div className="card">
        <label className="field">
          Subject (optional)
          <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} data-testid="try-subject" />
        </label>
        <label className="field">
          Email
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} maxLength={20000} placeholder="Paste a PM's back-charge email here" data-testid="try-body" />
        </label>
        <button type="button" className="btn" disabled={pending || !body.trim()} onClick={check} data-testid="try-check">
          {pending ? "Checking…" : "Check this email"}
        </button>
        <p className="meta">This is a live model call. Nothing is saved: the demo, its audit log and the ERP data don't change.</p>
      </div>

      {error && (
        <p role="alert" className="card danger err" data-testid="try-error">
          {error}
        </p>
      )}

      {shown && (
        <div data-testid="try-result">
          <p className="meta">
            Answered by {shown.result.model} in {(shown.result.latencyMs / 1000).toFixed(1)} s.
          </p>
          {shown.result.items.length === 0 && shown.result.rejected.length === 0 && <p className="card">No back-charge found.</p>}
          {shown.result.items.map((it, i) => (
            <div key={`${it.ref}-${i}`} className={`card ${OUTCOME_TONE[it.outcome]}`} data-testid={`try-item-${it.ref}`}>
              <div className="row">
                <div>
                  <strong>{it.refLabel}</strong> <span className="meta">· {it.description} · written as “{it.vendorAsWritten}” · job “{it.jobRef}”</span>
                </div>
                <div className="amt">{it.amount}</div>
              </div>
              <p>
                <span className={`status ${OUTCOME_TONE[it.outcome]}`} data-testid="try-outcome">
                  {OUTCOME_WORDS[it.outcome]}
                </span>
              </p>
              {it.holdReasons.length > 0 && (
                <ul className="plain">
                  {it.holdReasons.map((h, j) => (
                    <li key={j}>{h}</li>
                  ))}
                </ul>
              )}
              <p className="note" data-testid="try-note">
                {shown.result.note}
              </p>
              <h3>Source sentence</h3>
              <div className="quote">“{it.sourceSentence}”</div>
              {it.highlight ? (
                <pre className="body" data-testid="try-body-shown">
                  <Marked text={shown.sent} range={it.highlight} />
                </pre>
              ) : (
                <p className="status warn">Source sentence not found in the email</p>
              )}
              <h3>Checks</h3>
              <ul className="plain checks">
                {it.checks.map((c, j) => (
                  <li key={j} data-testid="try-check-line">
                    <strong className={c.passed ? "status ok" : "status danger"}>{c.passed ? "Passed" : "Failed"}</strong> {c.name}
                    {c.detail ? `: ${c.detail}` : ""}
                  </li>
                ))}
              </ul>
              <p className="meta">Link: {it.link.explanation.length ? it.link.explanation.join(" → ") : it.link.subcontractId ?? "not linked"}</p>
            </div>
          ))}
          {shown.result.rejected.length > 0 && (
            <div className="card warn">
              <strong>Model output the checks refused</strong>
              <ul className="plain">
                {shown.result.rejected.map((r, j) => (
                  <li key={j}>{r.reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </>
  );
}
