import Link from "next/link";
import { currentScreens } from "../../../ui/api.ts";
import { StatusWord } from "../../../ui/Bits.tsx";

export const dynamic = "force-dynamic";

export default async function PmQueue() {
  const c = await currentScreens();
  if (!c) return null;
  const { pmQueue } = c.s;
  return (
    <>
      <div className="page-head">
        <h1>PM queue</h1>
        <p className="sub">Items that need a project manager's decision. A held item stays here with its reason until a person deals with it.</p>
      </div>
      {pmQueue.length === 0 ? <p className="empty">Nothing waiting on the PM.</p> : null}
      <div className="stack">
        {pmQueue.map((q, i) =>
          // An item not taken in is not a back-charge: no detail screen (its ref may be empty or another row's).
          q.status.label.startsWith("Held: not taken in:") ? (
            <div key={i} className="item rejected" data-testid={`pm-queue-rejected-${i}`}>
              <div>
                <span className="rejected-tag">Not taken in</span>
                <StatusWord s={q.status} />
              </div>
            </div>
          ) : (
            <div key={i} className="item">
              <div className="item-title">
                <Link className="ref" href={`/backcharge/${q.ref}`}>
                  {q.ref}
                </Link>
                <StatusWord s={q.status} />
              </div>
            </div>
          ),
        )}
      </div>
    </>
  );
}
