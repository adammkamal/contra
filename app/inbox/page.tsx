import Link from "next/link";
import type { Screens } from "../../src/view.ts";
import { ActionButton } from "../../ui/ActionButton.tsx";
import { currentScreens } from "../../ui/api.ts";
import { ImageReading, photoAmountNote, StatusWord } from "../../ui/Bits.tsx";

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
      {s.inbox.map((r, idx) => {
        if (r.kind === "rejected") {
          const n = s.inbox.slice(0, idx).filter((x) => x.kind === "rejected").length; // 0, 1, ... among the rejected rows
          // Something the model returned that validation refused: not a back-charge. No amount, no buttons, no detail link.
          return (
            <div key={`rejected-${n}`} className="card rejected" data-testid={`rejected-row-${n}`}>
              <div>
                <span className="rejected-tag">Not taken in</span>
                <StatusWord s={r.status} />
              </div>
              {r.ref && <div className="meta">Back-charge number the model gave: {r.ref}</div>}
              <div className="meta">Email: {r.emailSubject}</div>
              <div className="meta">From: {r.emailFrom}</div>
              {r.attachments.length > 0 && (
                <ul className="plain meta" data-testid={`rejected-attachments-${n}`}>
                  {r.attachments.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        }
        // The server sends amount "" and sourceSentence "" until the PM confirms an amount read from an image.
        const unconfirmed = r.amount === "";
        const diff = r.photoAmount ? photoAmountNote(r.photoAmount) : null;
        return (
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
                {unconfirmed ? (
                  <div className="meta" data-testid={`hidden-reading-${r.ref}`}>
                    The model read an amount from a photo or scanned page. Open it in the original email and type the amount you see; the model’s reading is shown after you confirm.
                  </div>
                ) : r.photoAmount ? (
                  <ImageReading testId={`image-reading-${r.ref}`}>{r.sourceSentence}</ImageReading>
                ) : (
                  <div className="quote">“{r.sourceSentence}”</div>
                )}
                <div className="meta" data-testid={`source-location-${r.ref}`}>
                  Source: {r.sourceLocation}
                </div>
                {r.attachments.length > 0 && (
                  <ul className="plain meta" data-testid={`attachments-${r.ref}`}>
                    {r.attachments.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                )}
                <div className="meta">Link: {r.linkExplanation.length ? r.linkExplanation.join(" → ") : "not yet linked"}</div>
              </div>
              {unconfirmed ? (
                <div className="amt pending">Amount shown after you confirm</div>
              ) : (
                <div className="amt">
                  <div data-testid={`amount-${r.ref}`}>{r.amount}</div>
                  {diff && (
                    <div className="meta" style={{ fontSize: ".85rem", fontWeight: 400, whiteSpace: "normal" }} data-testid={`amount-difference-${r.ref}`}>
                      {diff}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div>
              <StatusWord s={r.status} />
            </div>
            {r.actions.map((a, i) => (
              <ActionButton key={i} action={a} next={s.nextStep.action} />
            ))}
          </div>
        );
      })}
    </>
  );
}
