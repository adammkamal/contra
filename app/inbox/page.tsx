import Link from "next/link";
import { ActionButton } from "../../ui/ActionButton.tsx";
import { StatusWord } from "../../ui/Bits.tsx";
import { screens } from "../../ui/data.ts";
import { usedSampleExtractions } from "../../ui/server.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function Inbox() {
  const s = screens();
  return (
    <>
      <h1>Inbox</h1>
      <p className="sub">Back-charges extracted from PM emails. Each amount sits beside the sentence it came from.</p>
      {usedSampleExtractions() && <p><strong>Sample extractions (not model output)</strong></p>}
      {s.inbox.length === 0 && <p>No emails ingested yet. Use “Ingest PM emails” in the top bar.</p>}
      {s.inbox.map((r) => (
        <div key={r.ref} className={`card ${r.status.tone}`}>
          <div className="row">
            <div>
              <strong><Link href={`/backcharge/${r.ref}`}>{r.ref}</Link></strong>
              <span className="meta"> · {r.emailSubject} · written as “{r.vendorAsWritten}”</span>
              <div className="quote">“{r.sourceSentence}”</div>
              <div className="meta">Link: {r.linkExplanation.length ? r.linkExplanation.join(" → ") : "not yet linked"}</div>
            </div>
            <div className="amt">{r.amount}</div>
          </div>
          <div><span className={`status ${r.status.tone}`}>{r.status.label}</span></div>
          {r.actions.map((a, i) => <ActionButton key={i} action={a} next={s.nextStep.action} />)}
        </div>
      ))}
    </>
  );
}
