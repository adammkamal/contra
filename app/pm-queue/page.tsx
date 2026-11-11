import Link from "next/link";
import { currentScreens } from "../../ui/api.ts";
import { StatusWord } from "../../ui/Bits.tsx";

export const dynamic = "force-dynamic";

export default async function PmQueue() {
  const c = await currentScreens();
  if (!c) return null;
  const { pmQueue } = c.s;
  return (
    <>
      <h1>PM queue</h1>
      <p className="sub">Items that need a project manager's decision.</p>
      {pmQueue.length === 0 && <p>Nothing waiting on the PM.</p>}
      {pmQueue.map((q) => (
        <div key={q.ref} className={`card ${q.status.tone}`}>
          <strong>
            <Link href={`/backcharge/${q.ref}`}>{q.ref}</Link>
          </strong>{" "}
          <StatusWord s={q.status} />
        </div>
      ))}
    </>
  );
}
