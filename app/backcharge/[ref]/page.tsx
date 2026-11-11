import Link from "next/link";
import { chosenWorkspace, getDetail } from "../../../ui/api.ts";
import { findSentence, Marked, StatusWord } from "../../../ui/Bits.tsx";

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
  const range = d.email ? findSentence(d.email.body, d.sourceSentence) : null;
  return (
    <>
      <p>
        <Link href="/inbox">← Inbox</Link>
      </p>
      <div className="row">
        <h1>
          {d.ref} <span className="meta">{d.description}</span>
        </h1>
        <div className="amt">{d.amount}</div>
      </div>
      <p>
        <StatusWord s={d.status} />
      </p>
      <p className="meta">
        Written as “{d.vendorAsWritten}” · job “{d.jobRef}”
      </p>

      <h2>Source</h2>
      <div className="quote">“{d.sourceSentence}”</div>
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
            <Marked text={d.email.body} range={range} />
          </pre>
          {!range && <p className="status warn">Source sentence not found in the email</p>}
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
