import { ActionButton } from "../../ui/ActionButton.tsx";
import { SimRamp, StatusWord } from "../../ui/Bits.tsx";
import { screens } from "../../ui/data.ts";
import { getApp } from "../../ui/server.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function Credits() {
  const s = screens();
  const app = getApp();
  const next = s.nextStep.action;
  return (
    <>
      <h1>Credits &amp; bills<SimRamp /></h1>
      <p className="sub">Ramp has no API to create credits; the simulated Ramp has one only so the demo can run.</p>
      <h2>Vendor credits</h2>
      {s.credits.length === 0 && <p>No credits yet.</p>}
      {s.credits.map((c) => {
        const memo = c.hasMemo ? app.ctx.contra.creditMemo(c.id) : null;
        return (
          <div key={c.id} className="card info">
            <div className="row"><div><strong>{c.id}</strong> <span className="meta">job {c.job} · covers {c.refs.join(", ")}</span></div><div className="amt">{c.amount}</div></div>
            <div><StatusWord s={c.status} /></div>
            {c.actions.map((a, i) => <ActionButton key={i} action={a} next={next} />)}
            {memo && <><h2>Credit memo for the Ramp AP inbox: {memo.filename}</h2><pre className="body">{memo.text}</pre></>}
          </div>
        );
      })}
      <h2>Bills<SimRamp /></h2>
      {s.bills.length === 0 && <p>No bill yet.</p>}
      {next?.command === "billArrives" && <ActionButton action={next} next={next} />}
      {s.bills.map((b) => (
        <div key={b.id} className="card info">
          <div className="row"><div><strong>{b.vendor}</strong> <span className="meta">{b.id} · job {b.job} · credits {b.creditsOn ? "on" : "off"}</span></div><div className="amt">{b.amount}</div></div>
          <div><StatusWord s={b.status} />{b.paid && <> · paid <strong>{b.paid}</strong></>}</div>
          <h2>Bill-arrival check: <StatusWord s={b.check.status} /></h2>
          {b.check.actions.length > 0 && <ul className="plain">{b.check.actions.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          {b.check.warnings.length > 0 && <ul className="plain">{b.check.warnings.map((x, i) => <li key={i}><strong>Warning:</strong> {x}</li>)}</ul>}
          <div>Would pay: <strong>{b.check.wouldPay}</strong></div>
          {b.actions.map((a, i) => <ActionButton key={i} action={a} next={next} />)}
        </div>
      ))}
    </>
  );
}
