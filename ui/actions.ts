"use server";
import { revalidatePath } from "next/cache";
import * as c from "../src/commands.ts";
import { loadFixtures } from "../src/extract/index.ts";
import type { Action } from "../src/view.ts";
import { getApp, resetApp, setExtractionSource } from "./server.ts";

export type Result = { error?: string };

async function guard(fn: () => void): Promise<Result> {
  try {
    fn();
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    revalidatePath("/", "layout");
  }
}

/** extra.option: the subcontract the PM picked. extra.reason: why the controller rejects a credit. */
export async function runAction(action: Action, extra: { option?: string; reason?: string } = {}): Promise<Result> {
  return guard(() => {
    const app = getApp();
    switch (action.command) {
      case "confirmLink": return void c.confirmLink(app, action.ref);
      case "chooseSubcontract": {
        const option = extra.option ?? action.options[0];
        if (!option) throw new Error("Choose a subcontract first.");
        return void c.confirmLink(app, action.ref, option);
      }
      case "draftNotice": return void c.draftNotice(app, action.subcontractId);
      case "approveNotice": return void c.approveNotice(app, action.noticeId);
      case "sendNotice": return void c.sendNotice(app, action.noticeId);
      case "ingestSubReply": return void c.ingestSubReply(app, action.noticeId);
      case "advanceDays": return void c.advanceDays(app, action.days);
      case "evaluateAll": return void c.evaluateAll(app);
      case "proposeCredit": return void c.proposeCredit(app, action.subcontractId);
      case "approveCredit": return void c.approveCredit(app, action.creditId);
      case "rejectCredit": {
        const why = extra.reason?.trim();
        if (!why) throw new Error("Type a reason to reject the credit.");
        return void c.rejectCredit(app, action.creditId, why);
      }
      case "billArrives": return void c.billArrives(app);
      case "turnOnCredits": return void c.turnOnCredits(app, action.billId);
      case "payBill": return void c.payBill(app, action.billId);
      default: {
        const unhandled: never = action;
        throw new Error(`No handler for ${JSON.stringify(unhandled)}`);
      }
    }
  });
}

/** Uses recorded model output when every email has a fixture; otherwise the built-in sample, disclosed on the Inbox. */
export async function ingestAction(): Promise<Result> {
  return guard(() => {
    const app = getApp();
    const rec = loadFixtures("fixtures/extractions", app.ctx.seed.emails.map((e) => e.id));
    if (rec) {
      c.ingestPmEmails(app, { extractions: rec.extractions, extractor: { kind: "llm", id: "extractor", model: rec.model } });
      setExtractionSource("recorded");
    } else {
      c.ingestPmEmails(app);
      setExtractionSource("sample");
    }
  });
}

export async function resetAction(): Promise<Result> {
  return guard(() => void resetApp());
}
