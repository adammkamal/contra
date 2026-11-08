"use client";
import { useState, useTransition } from "react";
import type { Action } from "../src/view.ts";
import { ingestAction, resetAction, runAction } from "./actions.ts";

const LABELS: Record<Action["command"], string> = {
  confirmLink: "Confirm link",
  chooseSubcontract: "Use this subcontract",
  draftNotice: "Draft notice",
  approveNotice: "Approve notice",
  sendNotice: "Send notice",
  ingestSubReply: "Ingest Ridgeline's reply",
  advanceDays: "Advance days",
  evaluateAll: "Check eligibility",
  proposeCredit: "Propose credit",
  approveCredit: "Approve credit",
  rejectCredit: "Reject credit",
  billArrives: "Bill arrives",
  turnOnCredits: "Turn on credits",
  payBill: "Pay bill (simulated)",
};

function idOf(a: Action): string | undefined {
  switch (a.command) {
    case "confirmLink":
    case "chooseSubcontract":
      return a.ref;
    case "draftNotice":
    case "proposeCredit":
      return a.subcontractId;
    case "approveNotice":
    case "sendNotice":
    case "ingestSubReply":
      return a.noticeId;
    case "approveCredit":
    case "rejectCredit":
      return a.creditId;
    case "turnOnCredits":
    case "payBill":
      return a.billId;
    default:
      return undefined;
  }
}

const same = (a: Action, b: Action | null) => !!b && JSON.stringify(a) === JSON.stringify(b);

export function ActionButton({ action, next, prefix = "" }: { action: Action; next: Action | null; prefix?: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [reason, setReason] = useState("");
  const [option, setOption] = useState(action.command === "chooseSubcontract" ? action.options[0] : undefined);
  const id = idOf(action);
  const label = action.command === "advanceDays" ? `Advance ${action.days} days` : LABELS[action.command];
  const go = () => start(async () => setError((await runAction(action, { option, reason })).error));
  return (
    <span className="action">
      {action.command === "chooseSubcontract" && (
        <select aria-label="Subcontract" value={option} onChange={(e) => setOption(e.target.value)}>
          {action.options.map((o) => <option key={o}>{o}</option>)}
        </select>
      )}
      {action.command === "rejectCredit" && (
        <input aria-label="Reason" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      )}
      <button
        type="button"
        className={same(action, next) ? "btn next" : "btn"}
        data-testid={`${prefix}${action.command}${id ? `-${id}` : ""}`}
        disabled={pending}
        onClick={go}
      >
        {label}
      </button>
      {error && <span role="alert" className="err">{error}</span>}
    </span>
  );
}

/** Buttons that have no Action: ingest (first step) and reset. */
export function PlainButton({ kind, highlight }: { kind: "ingest" | "reset"; highlight?: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const run = () => start(async () => setError((await (kind === "ingest" ? ingestAction() : resetAction())).error));
  return (
    <span className="action">
      <button
        type="button"
        className={highlight ? "btn next" : "btn quiet"}
        data-testid={kind === "ingest" ? "ingestPmEmails" : "resetDemo"}
        disabled={pending}
        onClick={run}
      >
        {kind === "ingest" ? "Ingest PM emails" : "Reset demo"}
      </button>
      {error && <span role="alert" className="err">{error}</span>}
    </span>
  );
}
