import { currentScreens } from "../../ui/api.ts";
import { hiddenReadings, redact } from "../../ui/Bits.tsx";

export const dynamic = "force-dynamic";

export default async function Audit() {
  const c = await currentScreens();
  if (!c) return null;
  const hidden = hiddenReadings(c.s); // a photo's reading is hidden until the PM confirms the amount
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
              <td>{redact(e.what, hidden)}</td>
              <td>{e.evidence.map((x) => redact(x, hidden)).join(" | ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
