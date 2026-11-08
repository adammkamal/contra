import Link from "next/link";
import { StatusWord } from "../../ui/Bits.tsx";
import { screens } from "../../ui/data.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function PmQueue() {
  const { pmQueue } = screens();
  return (
    <>
      <h1>PM queue</h1>
      <p className="sub">Items that need a project manager's decision.</p>
      {pmQueue.length === 0 && <p>Nothing waiting on the PM.</p>}
      {pmQueue.map((q) => (
        <div key={q.ref} className="card warn"><strong><Link href={`/backcharge/${q.ref}`}>{q.ref}</Link></strong> <StatusWord s={q.status} /></div>
      ))}
    </>
  );
}
