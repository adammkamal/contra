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
      {pmQueue.map((q, i) =>
        // An item not taken in is not a back-charge: no detail screen (its ref may be empty or another row's).
        q.kind !== "backCharge" ? (
          <div key={i} className="card rejected" data-testid={`pm-queue-${q.kind}-${i}`}>
            <span className="rejected-tag">{q.kind === "rejected" ? "Not taken in" : q.kind === "noBackCharge" ? "No back-charge found" : "Couldn't process"}</span>
            <StatusWord s={q.status} />
          </div>
        ) : (
          <div key={i} className={`card ${q.status.tone}`}>
            <strong>
              <Link href={`/backcharge/${q.ref}`}>{q.refLabel}</Link>
            </strong>{" "}
            <StatusWord s={q.status} />
          </div>
        ),
      )}
    </>
  );
}
