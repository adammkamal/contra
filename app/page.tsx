import { currentScreens } from "../ui/api.ts";
import { SampleData } from "../ui/Bits.tsx";

export const dynamic = "force-dynamic";

/** Decoration only: the status word is shown as written, and an unknown word simply gets no colour. */
const ROW_TONE: Record<string, string> = { "not deducted": "danger", "possible match": "warn", deducted: "ok" };

export default async function Opener() {
  const c = await currentScreens();
  if (!c) return null;
  const o = c.s.opener;
  return (
    <>
      {/* The opener is always the sample history, in both workspaces. */}
      <section className="shell opener">
        <div className="core opener-lead">
          <h1>
            Missed back-charges
            <SampleData />
          </h1>
          <div className="stack">
            <p className="figure">{o.notDeducted}</p>
            <p className="figure-claim">in past back-charges was never deducted from a sub's bill.</p>
          </div>
          <p className="sub">Older PM emails compared with Ramp credits and paid bills. Read-only.</p>
        </div>
        <div className="opener-side">
          <div className="tally">
            <span className="status warn">Possible match (amount only)</span>
            <span className="tally-figure">{o.possible}</span>
          </div>
          <div className="tally">
            <span className="status ok">Deducted</span>
            <span className="tally-figure">{o.deducted}</span>
          </div>
        </div>
      </section>

      <h2>Back-charge by back-charge</h2>
      <table className="rows">
        <thead>
          <tr>
            <th>Back-charge</th>
            <th>Status</th>
            <th>Evidence</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {o.rows.map((r) => (
            <tr key={r.ref}>
              <td className="strong nowrap">{r.ref}</td>
              <td className="nowrap">
                <span className={`status ${ROW_TONE[r.status] ?? "plain"}`}>{r.status}</span>
              </td>
              <td>{r.evidence}</td>
              <td className="num">{r.amount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
