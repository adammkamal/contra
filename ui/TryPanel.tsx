"use client";
import { useState, useTransition } from "react";
import type { TryInput, TryOutcome, TryResult } from "../server/try.ts";
import { tryEmail } from "./actions.ts";
import { Chain, Marked } from "./Bits.tsx";

/** "Show as" wording from FRONTEND_CONTRACT.md ("Try any email"). Never worded as a credit. */
const OUTCOME_WORDS: Record<TryOutcome, string> = {
  held_at_intake: "Held when the email came in",
  will_hold_dispute: "Will be held: dispute noted in the email",
  needs_link: "PM must choose the subcontract",
  ready_for_notice: "Ready for a notice to the sub",
};
const OUTCOME_TONE: Record<TryOutcome, string> = { held_at_intake: "danger", will_hold_dispute: "warn", needs_link: "warn", ready_for_notice: "ok" };
const OUTCOMES = Object.keys(OUTCOME_WORDS) as TryOutcome[];

/** Made-up emails (the same ones as contract/samples/try-*.json), so a stranger has something to press. */
const OPENING = "Hi,\n\nA condensate line from the level 3 fan coil was left uncapped and leaked onto the corridor ceiling.\n\nBC-5521: ceiling tile and grid repair, level 3 corridor, $1,840.00 per the attached invoice.\n\n";
const CLOSING = "Thanks,\nNoor Haddad\nProject Manager";
const EXAMPLES: { name: string; to: string; subject: string; body: string }[] = [
  { name: "A clean back-charge", to: "Harbor Mechanical Co <service@harbormech.example>", subject: "Summit MOB - back-charge for ceiling repair", body: OPENING + CLOSING },
  {
    name: "One the PM says is disputed",
    to: "Harbor Mechanical Co <service@harbormech.example>",
    subject: "Summit MOB - back-charge for ceiling repair",
    body: `${OPENING}Harbor disputes BC-5521; their foreman says the line was capped.\n\n${CLOSING}`,
  },
];

export function TryPanel() {
  const [to, setTo] = useState("");
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
      const input: TryInput = to.trim() ? { subject, body: sent, to } : { subject, body: sent };
      const r = await tryEmail(input);
      if (r.ok) setShown({ sent, result: r.result });
      else {
        setShown(null);
        setError(r.error);
      }
    });

  return (
    <div className="try-grid">
      <div className="panel try-form">
        <div className="try-examples">
          <span>No email to hand? Fill in a made-up one:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex.name}
              type="button"
              className="btn quiet"
              onClick={() => {
                setTo(ex.to);
                setSubject(ex.subject);
                setBody(ex.body);
              }}
            >
              {ex.name}
            </button>
          ))}
        </div>
        <label className="field">
          To (optional, the sub the PM wrote to)
          <input value={to} onChange={(e) => setTo(e.target.value)} maxLength={300} data-testid="try-to" />
        </label>
        <label className="field">
          Subject (optional)
          <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} data-testid="try-subject" />
        </label>
        <label className="field">
          Email
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={11} maxLength={20000} placeholder="Paste a PM's back-charge email here" data-testid="try-body" />
        </label>
        <div className="action">
          <button type="button" className="btn solid" disabled={pending || !body.trim()} aria-busy={pending} onClick={check} data-testid="try-check">
            {pending ? "Checking…" : "Check this email"}
          </button>
        </div>
        <p className="meta">This is a live model call. Nothing is saved: the demo, its audit log and the ERP data don't change.</p>
      </div>

      <div className="try-results" aria-live="polite">
        {error ? (
          <p role="alert" className="card danger err" data-testid="try-error">
            {error}
          </p>
        ) : null}

        {!shown && !error ? (
          <div className="panel">
            <h2>What comes back</h2>
            <p className="meta">Contra answers with one of these for each back-charge it finds. None of them is a credit: a credit still needs a notice, the response window and a controller.</p>
            <ul className="outcomes">
              {OUTCOMES.map((o) => (
                <li key={o}>
                  <span className={`status ${OUTCOME_TONE[o]}`}>{OUTCOME_WORDS[o]}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {shown ? (
          <div className="try-results" data-testid="try-result">
            <p className="meta notes">
              Answered by {shown.result.model} in {(shown.result.latencyMs / 1000).toFixed(1)} s.
            </p>
            {shown.result.items.length === 0 && shown.result.rejected.length === 0 ? <p className="empty">No back-charge found.</p> : null}
            {shown.result.items.map((it, i) => (
              <article key={`${it.ref}-${i}`} className="panel" data-testid={`try-item-${it.ref}`}>
                <div className="item-head">
                  <div className="item-title">
                    <span className="ref">{it.ref}</span>
                    <span className="item-about">
                      {it.description} · written as “{it.vendorAsWritten}” · job “{it.jobRef}”
                    </span>
                  </div>
                  <div className="amt">{it.amount}</div>
                </div>
                <p className="outcome-line">
                  <span className={`status ${OUTCOME_TONE[it.outcome]}`} data-testid="try-outcome">
                    {OUTCOME_WORDS[it.outcome]}
                  </span>
                </p>
                {it.holdReasons.length > 0 ? (
                  <ul className="plain">
                    {it.holdReasons.map((h, j) => (
                      <li key={j}>{h}</li>
                    ))}
                  </ul>
                ) : null}
                <p className="note" data-testid="try-note">
                  {shown.result.note}
                </p>
                <div className="part">
                  <h3>Source sentence</h3>
                  {/* Marked in the email below only when the backend found it there; shown plain here. */}
                  <blockquote className="quote">“{it.sourceSentence}”</blockquote>
                  {it.highlight ? (
                    <pre className="body" data-testid="try-body-shown">
                      <Marked text={shown.sent} range={it.highlight} />
                    </pre>
                  ) : (
                    <p className="status warn">Source sentence not found in the email</p>
                  )}
                </div>
                <div className="part">
                  <h3>Checks</h3>
                  <ul className="checks">
                    {it.checks.map((c, j) => (
                      <li key={j} data-testid="try-check-line">
                        <strong className={c.passed ? "status ok" : "status danger"}>{c.passed ? "Passed" : "Failed"}</strong> {c.name}
                        {c.detail ? `: ${c.detail}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="part">
                  <h3>Link</h3>
                  <Chain steps={it.link.explanation} empty={it.link.subcontractId ?? "not linked"} />
                </div>
              </article>
            ))}
            {shown.result.rejected.length > 0 ? (
              <div className="panel">
                <h2>Model output the checks refused</h2>
                <ul className="plain">
                  {shown.result.rejected.map((r, j) => (
                    <li key={j}>{r.reason}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
