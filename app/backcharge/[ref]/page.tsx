import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusWord } from "../../../ui/Bits.tsx";
import { screens } from "../../../ui/data.ts";
import { getApp } from "../../../ui/server.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Detail({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const row = screens().inbox.find((r) => r.ref === ref);
  if (!row) notFound();
  const result = getApp().ctx.contra.explainEligibility(ref);
  return (
    <>
      <p><Link href="/inbox">← Inbox</Link></p>
      <div className="row"><h1>{row.ref}</h1><div className="amt">{row.amount}</div></div>
      <p><StatusWord s={row.status} /></p>
      <div className="quote">“{row.sourceSentence}”</div>
      <h2>Eligibility: {result.status}</h2>
      <ul className="plain trace">{result.trace.map((t, i) => <li key={i}>{t}</li>)}</ul>
      {result.holdReasons.length > 0 && <p>Hold reasons: {result.holdReasons.join(", ")}</p>}
    </>
  );
}
