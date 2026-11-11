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
      <div className="page-head">
        <h1>
          Credits &amp; bills
          <SimRamp />
        </h1>
        <p className="sub">Ramp has no API to create credits; the simulated Ramp has one only so the demo can run. The real route is the credit memo, sent to the AP inbox.</p>
      </div>

      <h2>Vendor credits</h2>
      {s.credits.length === 0 ? <p className="empty">No credits yet.</p> : null}
      {s.credits.map((cr, i) => {
        const memo = memos[i];
        return (
          <article key={cr.id} className="item" data-testid={`credit-${cr.id}`}>
            <div className="item-head">
              <div className="item-title">
                <span className="ref">{cr.id}</span>
                <span className="item-about">
                  job {cr.job} · covers {cr.refs.join(", ")}
                </span>
              </div>
              <div className="amt" data-testid={`credit-amount-${cr.id}`}>
                {cr.amount}
              </div>
            </div>
            {cr.amountNotes.length > 0 ? (
              <ul className="plain note" data-testid={`amount-notes-${cr.id}`}>
                {cr.amountNotes.map((n, k) => (
                  <li key={k}>{n}</li>
                ))}
              </ul>
            ) : null}
            {memo?.ok ? (
              <details>
                <summary>Credit memo for the AP inbox: {memo.data.filename}</summary>
                <pre className="body memo">{memo.data.text}</pre>
              </details>
            ) : null}
            <div className="item-foot">
              <div className="stack">
                <StatusWord s={cr.status} />
                {cr.memo ? (
                  <div className="memo-status">
                    Credit memo:{" "}
                    <span data-testid={`memo-status-${cr.id}`}>
                      <StatusWord s={cr.memo} />
                    </span>
                  </div>
                ) : null}
              </div>
              <div className="actions">
                {cr.actions.map((a, j) => (
                  <ActionButton key={j} action={a} next={next} />
                ))}
              </div>
            </div>
          </article>
        );
      })}

      <h2>
        Bills
        <SimRamp />
      </h2>
      {s.bills.length === 0 ? <p className="empty">No bill yet.</p> : null}
      {s.bills.map((b) => (
        <article key={b.id} className="item" data-testid={`bill-${b.id}`}>
          <div className="item-head">
            <div className="item-title">
              <span className="ref">{b.vendor}</span>
              <span className="item-about">
                {b.id} · job {b.job} · credits {b.creditsOn ? "on" : "off"}
              </span>
            </div>
            <StatusWord s={b.status} />
          </div>
          <div className="statement">
            <div className="statement-line">
              <span className="what">Bill from the sub</span>
              <span className="how-much">{b.amount}</span>
            </div>
            <div className="statement-words">
              <h3>
                Bill-arrival check: <StatusWord s={b.check.status} />
              </h3>
              {b.check.actions.length > 0 ? (
                <ul className="plain">
                  {b.check.actions.map((x, j) => (
                    <li key={j}>{x}</li>
                  ))}
                </ul>
              ) : null}
              {b.check.warnings.length > 0 ? (
                <ul className="plain">
                  {b.check.warnings.map((x, j) => (
                    <li key={j}>
                      <strong>Warning:</strong> {x}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className={b.paid ? "statement-line" : "statement-line total"}>
              <span className="what">Would pay</span>
              <strong className="how-much">{b.check.wouldPay}</strong>
            </div>
            {b.paid ? (
              <div className="statement-line total">
                <span className="what">Paid</span>
                <strong className="how-much" data-testid={`bill-paid-${b.id}`}>
                  {b.paid}
                </strong>
              </div>
            ) : null}
          </div>
          {b.actions.length > 0 ? (
            <div className="item-foot">
              <span className="meta">Payment is simulated. No money moves.</span>
              <div className="actions">
                {b.actions.map((a, j) => (
                  <ActionButton key={j} action={a} next={next} />
                ))}
              </div>
            </div>
          ) : null}
        </article>
      ))}
    </>
  );
}
