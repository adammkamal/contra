import { ActionButton } from "../../ui/ActionButton.tsx";
import { currentScreens, getMemo } from "../../ui/api.ts";
import { SimRamp, StatusWord } from "../../ui/Bits.tsx";

export const dynamic = "force-dynamic";

export default async function Credits() {
  const c = await currentScreens();
  if (!c) return null;
  const { s, ws } = c;
  const next = s.nextStep.action;
  const memos = await Promise.all(s.credits.map((cr) => (cr.hasMemo ? getMemo(ws, cr.id) : null)));
  return (
    <>
      <h1>
        Credits &amp; bills
        <SimRamp />
      </h1>
      <p className="sub">Ramp has no API to create credits; the simulated Ramp has one only so the demo can run. The real route is the credit memo, sent to the AP inbox.</p>
      <h2>Vendor credits</h2>
      {s.credits.length === 0 && <p>No credits yet.</p>}
      {s.credits.map((cr, i) => {
        const memo = memos[i];
        return (
          <div key={cr.id} className={`card ${cr.status.tone}`} data-testid={`credit-${cr.id}`}>
            <div className="row">
              <div>
                <strong>{cr.id}</strong>{" "}
                <span className="meta">
                  job {cr.job} · covers {cr.refs.join(", ")}
                </span>
              </div>
              <div className="amt" data-testid={`credit-amount-${cr.id}`}>
                {cr.amount}
              </div>
            </div>
            <div>
              <StatusWord s={cr.status} />
            </div>
            {cr.memo && (
              <div className="memo-status">
                Credit memo: <span data-testid={`memo-status-${cr.id}`}>
                  <StatusWord s={cr.memo} />
                </span>
              </div>
            )}
            {cr.actions.map((a, j) => (
              <ActionButton key={j} action={a} next={next} />
            ))}
            {memo?.ok && (
              <details>
                <summary>Credit memo for the AP inbox: {memo.data.filename}</summary>
                <pre className="body">{memo.data.text}</pre>
              </details>
            )}
          </div>
        );
      })}
      <h2>
        Bills
        <SimRamp />
      </h2>
      {s.bills.length === 0 && <p>No bill yet.</p>}
      {s.bills.map((b) => (
        <div key={b.id} className={`card ${b.status.tone}`} data-testid={`bill-${b.id}`}>
          <div className="row">
            <div>
              <strong>{b.vendor}</strong>{" "}
              <span className="meta">
                {b.id} · job {b.job} · credits {b.creditsOn ? "on" : "off"}
              </span>
            </div>
            <div className="amt">{b.amount}</div>
          </div>
          <div>
            <StatusWord s={b.status} />
            {b.paid && (
              <>
                {" "}
                · paid <strong data-testid={`bill-paid-${b.id}`}>{b.paid}</strong>
              </>
            )}
          </div>
          <h3>
            Bill-arrival check: <StatusWord s={b.check.status} />
          </h3>
          {b.check.actions.length > 0 && (
            <ul className="plain">
              {b.check.actions.map((x, j) => (
                <li key={j}>{x}</li>
              ))}
            </ul>
          )}
          {b.check.warnings.length > 0 && (
            <ul className="plain">
              {b.check.warnings.map((x, j) => (
                <li key={j}>
                  <strong>Warning:</strong> {x}
                </li>
              ))}
            </ul>
          )}
          <div>
            Would pay: <strong>{b.check.wouldPay}</strong>
          </div>
          {b.actions.map((a, j) => (
            <ActionButton key={j} action={a} next={next} />
          ))}
        </div>
      ))}
    </>
  );
}
