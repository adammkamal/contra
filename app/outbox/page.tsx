import { ActionButton } from "../../ui/ActionButton.tsx";
import { StatusWord } from "../../ui/Bits.tsx";
import { screens } from "../../ui/data.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function Outbox() {
  const s = screens();
  return (
    <>
      <h1>Outbox</h1>
      <p className="sub">Notices to the subcontractor. Nothing is sent until the controller approves.</p>
      {s.outbox.length === 0 && <p>No notices yet.</p>}
      {s.outbox.map((n) => (
        <div key={n.id} className="card info">
          <div className="row"><div><strong>{n.id}</strong> <span className="meta">covers {n.refs.join(", ")}</span></div><div className="amt">{n.total}</div></div>
          <pre className="body">{n.body}</pre>
          <div><StatusWord s={n.status} /></div>
          {n.actions.map((a, i) => <ActionButton key={i} action={a} next={s.nextStep.action} />)}
        </div>
      ))}
    </>
  );
}
