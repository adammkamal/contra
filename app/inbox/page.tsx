import Link from "next/link";
import type { Screens } from "../../src/view.ts";
import { ActionButton } from "../../ui/ActionButton.tsx";
import { currentScreens } from "../../ui/api.ts";
import { StatusWord } from "../../ui/Bits.tsx";

export const dynamic = "force-dynamic";

const EMAIL_SOURCE: Record<NonNullable<Screens["emailSource"]>, string> = {
  eml: "Emails: .eml files",
  builtin: "Emails: built-in sample",
  gmail: "Emails: Gmail inbox",
  mixed: "Emails: more than one source",
};
const EXTRACTION_SOURCE: Record<NonNullable<Screens["extractionSource"]>, string> = {
  sample: "Sample extractions (hand-written), not model output",
  model: "Extracted by the AI model, then checked in code",
  mixed: "Some extractions are hand-written samples, some are model output",
};

export default async function Inbox() {
  const c = await currentScreens();
  if (!c) return null;
  const { s, ws } = c;
  return (
    <>
      <h1>Inbox</h1>
      <p className="sub">Back-charges extracted from PM emails. Each amount sits beside the sentence it came from.</p>
      {(s.extractionSource || s.emailSource) && (
        <p className="notes" data-testid="inbox-sources">
          {s.extractionSource && <strong data-testid="extraction-source">{EXTRACTION_SOURCE[s.extractionSource]}</strong>}
          {s.emailSource && <span> · {EMAIL_SOURCE[s.emailSource]}</span>}
        </p>
      )}
      {s.inbox.length === 0 && <p>{ws === "live" ? "No back-charge emails from the live inbox yet." : "No emails ingested yet. Use “Ingest PM emails” in the top bar."}</p>}
      {s.inbox.map((r) => (
        <div key={r.ref} className={`card ${r.status.tone}`} data-testid={`inbox-row-${r.ref}`}>
          <div className="row">
            <div>
              <strong>
                <Link href={`/backcharge/${r.ref}`}>{r.ref}</Link>
              </strong>
              <span className="meta">
                {" "}
                · {r.emailSubject} · written as “{r.vendorAsWritten}”
              </span>
              <div className="quote">“{r.sourceSentence}”</div>
              <div className="meta">Link: {r.linkExplanation.length ? r.linkExplanation.join(" → ") : "not yet linked"}</div>
            </div>
            <div className="amt">{r.amount}</div>
          </div>
          <div>
            <StatusWord s={r.status} />
          </div>
          {r.actions.map((a, i) => (
            <ActionButton key={i} action={a} next={s.nextStep.action} />
          ))}
        </div>
      ))}
    </>
  );
}
