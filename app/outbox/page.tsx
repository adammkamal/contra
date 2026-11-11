import { ActionButton } from "../../ui/ActionButton.tsx";
import { currentScreens } from "../../ui/api.ts";
import { StatusWord } from "../../ui/Bits.tsx";

export const dynamic = "force-dynamic";

export default async function Outbox() {
  const c = await currentScreens();
  if (!c) return null;
  const { s } = c;
  return (
    <>
      <div className="page-head">
        <h1>Outbox</h1>
        <p className="sub">Notices to the subcontractor. Nothing is sent until the PM approves.</p>
      </div>
      {s.outbox.length === 0 ? <p className="empty">No notices yet.</p> : null}
      {s.outbox.map((n) => (
        <article key={n.id} className="item" data-testid={`notice-${n.id}`}>
          <div className="item-head">
            <div className="item-title">
              <span className="ref">{n.id}</span>
              <span className="item-about">covers {n.refs.join(", ")}</span>
            </div>
            <div className="amt" data-testid={`notice-total-${n.id}`}>
              {n.total}
            </div>
          </div>
          <pre className="body">{n.body}</pre>
          <div className="item-foot">
            <StatusWord s={n.status} />
            <div className="actions">
              {n.actions.map((a, i) => (
                <ActionButton key={i} action={a} next={s.nextStep.action} />
              ))}
            </div>
          </div>
        </article>
      ))}
    </>
  );
}
