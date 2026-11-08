import { Badge } from "../ui/Bits.tsx";
import { screens } from "../ui/data.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function Opener() {
  const { opener: o } = screens();
  return (
    <>
      <h1>Missed back-charges<Badge>Sample data</Badge></h1>
      <p className="sub">Older PM emails compared with Ramp credits and paid bills. Read-only.</p>
      <div className="totals">
        <div className="card danger"><div className="status danger">Never deducted</div><div className="big">{o.notDeducted}</div></div>
        <div className="card warn"><div className="status warn">Possible match (amount only)</div><div className="big">{o.possible}</div></div>
        <div className="card ok"><div className="status ok">Deducted</div><div className="big">{o.deducted}</div></div>
      </div>
      <table>
        <thead><tr><th>Back-charge</th><th>Status</th><th>Evidence</th><th className="num">Amount</th></tr></thead>
        <tbody>{o.rows.map((r) => (
          <tr key={r.ref}><td>{r.ref}</td><td><strong>{r.status}</strong></td><td>{r.evidence}</td><td className="num">{r.amount}</td></tr>
        ))}</tbody>
      </table>
    </>
  );
}
