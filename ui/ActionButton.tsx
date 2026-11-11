"use client";
import { useState, useTransition } from "react";
import type { Action } from "../src/view.ts";
import { resetDemo, runAction } from "./actions.ts";

/** Button labels from FRONTEND_CONTRACT.md ("Buttons: Action"). */
const LABELS: Record<Action["command"], string> = {
  ingestPmEmails: "Ingest PM emails",
  confirmLink: "Confirm link",
  chooseSubcontract: "Confirm",
  confirmImageAmount: "Confirm",
  dismissEmail: "Dismiss",
  sameCharge: "Same charge (merge)",
  differentCharge: "Different charge",
  draftNotice: "Draft notice",
  approveNotice: "Approve notice",
  sendNotice: "Send notice",
  ingestSubReply: "Ingest sub's reply",
  advanceDays: "Advance a week",
  evaluateAll: "Check eligibility",
  proposeCredit: "Propose credit",
  approveCredit: "Approve credit",
  rejectCredit: "Reject",
  billArrives: "Bill arrives",
  turnOnCredits: "Turn on credits",
  payBill: "Pay (simulated)",
  sendCreditMemo: "Send credit memo",
};

/** The id part of data-testid="{command}-{id}" (contract: ref, noticeId, creditId, billId or subcontractId). */
function idOf(a: Action): string | undefined {
  switch (a.command) {
    case "confirmLink":
    case "chooseSubcontract":
    case "confirmImageAmount":
    case "sameCharge":
    case "differentCharge":
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
    case "sendCreditMemo":
      return a.creditId;
    case "turnOnCredits":
    case "payBill":
      return a.billId;
    case "dismissEmail":
      return a.emailId;
    default:
      return undefined;
  }
}

const same = (a: Action, b: Action | null) => !!b && JSON.stringify(a) === JSON.stringify(b);

export function ActionButton({ action, next, prefix = "" }: { action: Action; next: Action | null; prefix?: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  // chooseSubcontract starts unchosen; confirmImageAmount often has a single option, which is preselected.
  const [choice, setChoice] = useState(
    action.command === "chooseSubcontract" ? "" : action.command === "confirmImageAmount" && action.options.length === 1 ? action.options[0] : action.command === "confirmImageAmount" ? "" : undefined,
  );
  const id = idOf(action);
  const testId = `${prefix}${action.command}${id ? `-${id}` : ""}`;
  const go = () =>
    start(async () => {
      setError(undefined);
      const input =
        action.command === "chooseSubcontract" ? { choice } : action.command === "confirmImageAmount" ? { amount, choice } : action.command === "rejectCredit" || action.command === "dismissEmail" ? { reason } : {};
      setError((await runAction(action, input)).error);
    });
  const needsChoice = (action.command === "chooseSubcontract" || action.command === "confirmImageAmount") && !choice;
  const needsAmount = action.command === "confirmImageAmount" && !amount.trim();
  return (
    <span className="action">
      {action.command === "chooseSubcontract" && (
        <select aria-label={`Subcontract for ${action.ref}`} data-testid={`${testId}-choice`} value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">Choose a subcontract…</option>
          {action.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )}
      {action.command === "confirmImageAmount" && (
        <>
          <input
            aria-label={`Type the amount you see in the image for ${action.ref}`}
            placeholder="Type the amount you see in the image"
            data-testid={`${testId}-amount`}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <select aria-label={`Subcontract for ${action.ref}`} data-testid={`${testId}-choice`} value={choice} onChange={(e) => setChoice(e.target.value)}>
            {action.options.length > 1 && <option value="">Choose a subcontract…</option>}
            {action.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </>
      )}
      {action.command === "rejectCredit" && <input aria-label="Reason for rejecting" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />}
      {action.command === "dismissEmail" && (
        <input aria-label="Reason for dismissing" placeholder="Why dismiss it (e.g. not a back-charge)" data-testid={`${testId}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} />
      )}
      <button type="button" className={same(action, next) ? "btn next" : "btn"} data-testid={testId} disabled={pending || needsChoice || needsAmount} onClick={go}>
        {pending ? `${LABELS[action.command]}…` : LABELS[action.command]}
      </button>
      {error && (
        <span role="alert" className="err">
          {error}
        </span>
      )}
    </span>
  );
}

export function ResetDemoButton() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  return (
    <span className="action">
      <button type="button" className="btn quiet" data-testid="resetDemo" disabled={pending} onClick={() => start(async () => setError((await resetDemo()).error))}>
        Reset demo
      </button>
      {error && (
        <span role="alert" className="err">
          {error}
        </span>
      )}
    </span>
  );
}
