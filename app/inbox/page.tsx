import Link from "next/link";
import type { Screens } from "../../src/view.ts";
import { ActionButton } from "../../ui/ActionButton.tsx";
import { currentScreens } from "../../ui/api.ts";
import { Chain, differenceNote, Files, findConfirmation, ImageReading, isFromImage, Quote, StatusWord } from "../../ui/Bits.tsx";

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
      <div className="page-head">
        <h1>Inbox</h1>
        <p className="sub">Each back-charge sits beside the sentence a PM wrote. The marked sentence is where its amount came from.</p>
      </div>
      {s.extractionSource || s.emailSource ? (
        <p className="notes" data-testid="inbox-sources">
          {s.extractionSource ? <strong data-testid="extraction-source">{EXTRACTION_SOURCE[s.extractionSource]}</strong> : null}
          {s.emailSource ? <span className="meta"> · {EMAIL_SOURCE[s.emailSource]}</span> : null}
        </p>
      ) : null}
      {s.inbox.length === 0 ? (
        <p className="empty">{ws === "live" ? "No back-charge emails from the live inbox yet." : "No emails ingested yet. Use “Ingest PM emails” in the bar above."}</p>
      ) : null}
      <div className="stack">
        {s.inbox.map((r, idx) => {
          if (r.kind === "rejected") {
            const n = s.inbox.slice(0, idx).filter((x) => x.kind === "rejected").length; // 0, 1, ... among the rejected rows
            // Something the model returned that validation refused: not a back-charge. No amount, no buttons, no detail link.
            return (
              <article key={`rejected-${n}`} className="item rejected" data-testid={`rejected-row-${n}`}>
                <div>
                  <span className="rejected-tag">Not taken in</span>
                  <StatusWord s={r.status} />
                </div>
                <div className="source-line">
                  {r.ref ? <span>Back-charge number the model gave: {r.ref}</span> : null}
                  <span>Email: {r.emailSubject}</span>
                  <span>From: {r.emailFrom}</span>
                </div>
                <Files items={r.attachments} testId={`rejected-attachments-${n}`} />
              </article>
            );
          }
          const image = isFromImage(r);
          const confirmation = image ? findConfirmation(s.audit, r.sourceSentence) : null;
          const unconfirmed = image && !confirmation; // the model's reading stays hidden until the PM types the amount
          const diff = confirmation ? differenceNote(confirmation) : null;
          return (
            <article key={r.ref} className="item" data-testid={`inbox-row-${r.ref}`}>
              <div className="item-head">
                <div className="item-title">
                  <Link className="ref" href={`/backcharge/${r.ref}`}>
                    {r.ref}
                  </Link>
                  <span className="item-about">
                    {r.emailSubject} · written as “{r.vendorAsWritten}”
                  </span>
                </div>
                {unconfirmed ? (
                  <div className="amt pending">Amount shown after you confirm</div>
                ) : (
                  <div className="amt">
                    <div data-testid={`amount-${r.ref}`}>{r.amount}</div>
                    {diff ? (
                      <div className="amt-note" data-testid={`amount-difference-${r.ref}`}>
                        {diff}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
              <div className="item-body">
                <div className="part">
                  <h3>Where the amount came from</h3>
                  {unconfirmed ? (
                    <div className="hidden-reading" data-testid={`hidden-reading-${r.ref}`}>
                      The model read an amount from a photo or scanned page. Open it in the original email and type the amount you see; the model’s reading is shown after you confirm.
                    </div>
                  ) : image ? (
                    <ImageReading testId={`image-reading-${r.ref}`}>{r.sourceSentence}</ImageReading>
                  ) : (
                    <Quote>{r.sourceSentence}</Quote>
                  )}
                  <div className="source" data-testid={`source-location-${r.ref}`}>
                    Source: {r.sourceLocation}
                  </div>
                  <Files items={r.attachments} testId={`attachments-${r.ref}`} />
                </div>
                <div className="part">
                  <h3>Linked subcontract</h3>
                  <Chain steps={r.linkExplanation} empty="Not yet linked" />
                </div>
              </div>
              <div className="item-foot">
                <StatusWord s={r.status} />
                <div className="actions">
                  {r.actions.map((a, i) => (
                    <ActionButton key={i} action={a} next={s.nextStep.action} />
                  ))}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
