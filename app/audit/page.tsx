import { currentScreens } from "../../ui/api.ts";

export const dynamic = "force-dynamic";

export default async function Audit() {
  const c = await currentScreens();
  if (!c) return null;
  return (
    <>
      <h1>Audit log</h1>
      <p className="sub">Every transition with who did it, when, and the evidence. Newest first.</p>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Time</th>
            <th>Actor</th>
            <th>Event</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {c.s.audit.map((e) => (
            <tr key={e.seq}>
              <td>{e.seq}</td>
              <td>{e.at}</td>
              <td>{e.actor}</td>
              <td>{e.what}</td>
              <td>{e.evidence.join(" | ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
