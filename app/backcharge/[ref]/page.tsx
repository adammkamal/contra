import Link from "next/link";
import { chosenWorkspace, getDetail } from "../../../ui/api.ts";
import { findSentence, ImageReading, Marked, photoAmountNote, StatusWord } from "../../../ui/Bits.tsx";

export const dynamic = "force-dynamic";

export default async function Detail({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const ws = await chosenWorkspace();
  const r = await getDetail(ws, ref);
  if (!r.ok) {
    return (
      <>
        <p>
          <Link href="/inbox">← Inbox</Link>
        </p>
        {!r.down && <p className="card danger">{r.error}</p>}
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
      <p>
        <Link href="/inbox">← Inbox</Link>
      </p>
      <div className="row">
        <h1>
          {d.ref} <span className="meta">{d.description}</span>
        </h1>
        {unconfirmed ? (
          <div className="amt pending">Amount shown after the PM confirms it</div>
        ) : (
          <div className="amt">
            <div data-testid="detail-amount">{d.amount}</div>
            {diff && (
              <div className="meta" style={{ fontSize: ".85rem", fontWeight: 400, whiteSpace: "normal" }} data-testid="amount-difference">
                {diff}
              </div>
            )}
          </div>
        )}
      </div>
      <p>
        <StatusWord s={d.status} />
      </p>
      <p className="meta">
        Written as “{d.vendorAsWritten}” · job “{d.jobRef}”
      </p>

      <h2>Source</h2>
      {unconfirmed ? (
        <p className="meta" data-testid="hidden-reading">
          The model read an amount from an image. It is shown after the PM types the amount they see and confirms it.
        </p>
      ) : d.photoAmount ? (
        <ImageReading testId="image-reading">{d.sourceSentence}</ImageReading>
      ) : (
        <div className="quote">“{d.sourceSentence}”</div>
      )}
      <p className="meta" data-testid="source-location">
        Source: {d.sourceLocation}
      </p>
      {d.disputeSentence && (
        <p>
          <strong>Dispute noted:</strong> “{d.disputeSentence}”
        </p>
      )}
      {d.email && (
        <div className="card">
          <div className="meta">
            {d.email.from} · {d.email.subject}
          </div>
          <pre className="body">
            <Marked text={d.email.body} range={inBody ? range : null} />
          </pre>
          {inBody && !range && <p className="status warn">Source sentence not found in the email</p>}
          {d.email.attachments.length > 0 && (
            <>
              <h3>Attachments</h3>
              <ul className="plain" data-testid="detail-attachments">
                {d.email.attachments.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </>
          )}
          {d.email.attachmentText.map((t) => (
            <div key={t.where} data-testid="attachment-text">
              <div className="meta">{t.where}</div>
              <pre className="body">
                <Marked text={t.text} range={t.where === d.sourceLocation ? range : null} />
              </pre>
            </div>
          ))}
          {fromImage && (
            <p className="status warn" data-testid="image-source-note">
              This amount was read from an image, which can’t be checked word for word. Check it against {d.sourceLocation} in the original email.
            </p>
          )}
          {!inBody && pageText && !range && <p className="status warn">Source sentence not found in {d.sourceLocation}</p>}
        </div>
      )}

      <h2>Link</h2>
      <p>{d.link.subcontractId ?? "Not linked yet"}</p>
      {d.link.explanation.length > 0 && (
        <ul className="plain">
          {d.link.explanation.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}

      {d.clause && (
        <>
          <h2>Clause {d.clause.section}</h2>
          <blockquote className="quote">{d.clause.text}</blockquote>
          <p className="meta">
            Response window {d.clause.responseWindow} · deduction {d.clause.deductionAllowed ? "allowed" : "not allowed"} · notice {d.clause.noticeRequired ? "required" : "not required"}
          </p>
        </>
      )}

      <h2>Eligibility: {d.eligibility.status}</h2>
      {d.eligibility.holdReasons.length > 0 && <p>Held: {d.eligibility.holdReasons.join("; ")}</p>}
      {d.eligibility.waitingFor.length > 0 && <p>Waiting for: {d.eligibility.waitingFor.join("; ")}</p>}
      <ul className="plain trace">
        {d.eligibility.trace.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>

      <h2>History</h2>
      <table>
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
              <td>{h.at}</td>
              <td>{h.actor}</td>
              <td>{h.what}</td>
              <td>{h.evidence.join(" | ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
