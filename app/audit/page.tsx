import { currentScreens } from "../../ui/api.ts";

export const dynamic = "force-dynamic";

export default async function Audit() {
  const c = await currentScreens();
  if (!c) return null;
  return (
    <>
      <div className="page-head">
        <h1>Audit log</h1>
        <p className="sub">Every change, with who made it, when, and the evidence behind it. Newest first.</p>
      </div>
      {c.s.audit.length === 0 ? <p className="empty">Nothing has happened in this workspace yet.</p> : null}
      <table className="rows">
        <thead>
          <tr>
            <th>#</th>
            <th>Time</th>
            <th>Who</th>
            <th>What changed</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {c.s.audit.map((e) => (
            <tr key={e.seq}>
              <td className="meta">{e.seq}</td>
              <td className="nowrap meta">{e.at}</td>
              <td className="strong">{e.actor}</td>
              <td>{e.what}</td>
              <td>
                <ul className="evidence-list">
                  {e.evidence.map((x, i) => (
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
