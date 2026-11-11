import Link from "next/link";
import { chosenWorkspace, getDetail } from "../../../ui/api.ts";
import { Chain, Files, findSentence, ImageReading, Marked, photoAmountNote, Quote, StatusWord, Trace } from "../../../ui/Bits.tsx";

export const dynamic = "force-dynamic";

const BACK = (
  <Link className="back" href="/inbox">
    <span aria-hidden="true">←</span> Inbox
  </Link>
);

export default async function Detail({ params }: { params: Promise<{ ref: string }> }) {
  // The route's ref and the workspace cookie don't depend on each other.
  const [{ ref }, ws] = await Promise.all([params, chosenWorkspace()]);
  const r = await getDetail(ws, ref);
  if (!r.ok) {
    return (
      <>
        {BACK}
        {!r.down ? (
          <p className="card danger" role="alert">
            {r.error}
          </p>
        ) : null}
      </>
    );
  }
  const d = r.data;
  const inBody = d.sourceLocation === "email body";
  const pageText = d.email?.attachmentText.find((t) => t.where === d.sourceLocation);
  const range = d.email ? findSentence(inBody ? d.email.body : (pageText?.text ?? ""), d.sourceSentence) : null;
  const fromImage = !inBody && !pageText;
  // The server sends amount "" and sourceSentence "" until the PM confirms an amount read from an image.
  const unconfirmed = d.amount === "";
  const diff = d.photoAmount ? photoAmountNote(d.photoAmount) : null;
  return (
    <>
      {BACK}
      <div className="detail-head">
        <div className="stack">
          <h1>
            {d.ref} <span className="describe">{d.description}</span>
          </h1>
          <p>
            <StatusWord s={d.status} />
          </p>
          <p className="meta">
            Written as “{d.vendorAsWritten}” · job “{d.jobRef}”
          </p>
        </div>
        {unconfirmed ? (
          <div className="amt pending">Amount shown after the PM confirms it</div>
        ) : (
          <div className="amt">
            <div data-testid="detail-amount">{d.amount}</div>
            {diff ? (
              <div className="amt-note" data-testid="amount-difference">
                {diff}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="detail-grid">
        <section className="panel">
          <h2>Source</h2>
          {unconfirmed ? (
            <p className="hidden-reading" data-testid="hidden-reading">
              The model read an amount from an image. It is shown after the PM types the amount they see and confirms it.
            </p>
          ) : d.photoAmount ? (
            <ImageReading testId="image-reading">{d.sourceSentence}</ImageReading>
          ) : (
            <Quote>{d.sourceSentence}</Quote>
          )}
          <p className="source" data-testid="source-location">
            Source: {d.sourceLocation}
          </p>
          {d.disputeSentence ? (
            <p className="note">
              <strong>Dispute noted:</strong> “{d.disputeSentence}”
            </p>
          ) : null}
          {d.email ? (
            <div className="part">
              <h3>
                The email: {d.email.subject}, from {d.email.from}
              </h3>
              <pre className="body">
                <Marked text={d.email.body} range={inBody ? range : null} />
              </pre>
              {inBody && !range ? <p className="status warn">Source sentence not found in the email</p> : null}
              {d.email.attachments.length > 0 ? (
                <>
                  <h3>Attachments</h3>
                  <Files items={d.email.attachments} testId="detail-attachments" />
                </>
              ) : null}
              {d.email.attachmentText.map((t) => (
                <div key={t.where} className="part" data-testid="attachment-text">
                  <h3>{t.where}</h3>
                  <pre className="body">
                    <Marked text={t.text} range={t.where === d.sourceLocation ? range : null} />
                  </pre>
                </div>
              ))}
              {fromImage ? (
                <p className="status warn" data-testid="image-source-note">
                  This amount was read from an image, which can’t be checked word for word. Check it against {d.sourceLocation} in the original email.
                </p>
              ) : null}
              {!inBody && pageText && !range ? <p className="status warn">Source sentence not found in {d.sourceLocation}</p> : null}
            </div>
          ) : null}
        </section>

        <div className="stack">
          <section className="panel">
            <h2>Eligibility: {d.eligibility.status}</h2>
            {d.eligibility.holdReasons.length > 0 ? <p>Held: {d.eligibility.holdReasons.join("; ")}</p> : null}
            {d.eligibility.waitingFor.length > 0 ? <p>Waiting for: {d.eligibility.waitingFor.join("; ")}</p> : null}
            <Trace lines={d.eligibility.trace} />
          </section>

          {d.clause ? (
            <section className="panel">
              <h2>Clause {d.clause.section}</h2>
              <blockquote className="quote">{d.clause.text}</blockquote>
              <div className="facts">
                <span className="fact">Response window {d.clause.responseWindow}</span>
                <span className="fact">Deduction {d.clause.deductionAllowed ? "allowed" : "not allowed"}</span>
                <span className="fact">Notice {d.clause.noticeRequired ? "required" : "not required"}</span>
              </div>
            </section>
          ) : null}

          <section className="panel">
            <h2>Link</h2>
            <p className="strong">{d.link.subcontractId ?? "Not linked yet"}</p>
            <Chain steps={d.link.explanation} empty="No link steps recorded" />
          </section>
        </div>
      </div>

      <h2>History</h2>
      <table className="rows">
        <thead>
          <tr>
            <th>Time</th>
            <th>Who</th>
            <th>What</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {d.history.map((h) => (
            <tr key={h.seq}>
              <td className="nowrap meta">{h.at}</td>
              <td className="strong">{h.actor}</td>
              <td>{h.what}</td>
              <td>
                <ul className="evidence-list">
                  {h.evidence.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
