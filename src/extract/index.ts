import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Actor, Email, ExtractedBackCharge, ExtractedResponse } from "../types.ts";
import { callTool, type CallOptions, type ModelSettings } from "./anthropic.ts";
import { BACKCHARGE_SYSTEM, BACKCHARGE_TOOL, RESPONSE_SYSTEM, RESPONSE_TOOL } from "./prompt.ts";
import { parseBackCharges, parseResponse, type Rejected } from "./validate.ts";

const wrap = (e: Email) =>
  `<email id="${e.id}">\nFrom: ${e.from}\nTo: ${e.to}\nSubject: ${e.subject}\n\n${e.body}\n</email>`;

export async function extractBackCharges(
  settings: ModelSettings,
  email: Email,
  opts: CallOptions = {},
): Promise<{ ok: true; items: ExtractedBackCharge[]; rejected: Rejected[]; actor: Actor } | { ok: false; reason: string }> {
  const r = await callTool(settings, { system: BACKCHARGE_SYSTEM, user: wrap(email), tool: BACKCHARGE_TOOL }, opts);
  if (r.status !== "OK") return { ok: false, reason: `${r.status}: ${r.message}` };
  const parsed = parseBackCharges(r.toolInput, email);
  return { ok: true, ...parsed, actor: { kind: "llm", id: "extractor", model: r.model } };
}

export async function extractResponse(
  settings: ModelSettings,
  email: Email,
  notice: { id: string; backChargeRefs: readonly string[] },
  opts: CallOptions = {},
): Promise<{ ok: true; value: ExtractedResponse; actor: Actor } | { ok: false; reason: string }> {
  const user = `Notice ${notice.id} listed: ${notice.backChargeRefs.join(", ")}\n\n${wrap(email)}`;
  const r = await callTool(settings, { system: RESPONSE_SYSTEM, user, tool: RESPONSE_TOOL, maxTokens: 1024 }, opts);
  if (r.status !== "OK") return { ok: false, reason: `${r.status}: ${r.message}` };
  const p = parseResponse(r.toolInput, email, notice.id, notice.backChargeRefs);
  return p.ok ? { ok: true, value: p.value, actor: { kind: "llm", id: "extractor", model: r.model } } : p;
}

/** Recorded outputs: live runs write them, tests and the demo video replay them. */
export interface Fixture {
  model: string;
  recordedAt: string;
  items: ExtractedBackCharge[];
}

export function saveFixture(dir: string, emailId: string, f: Fixture): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${emailId}.json`), JSON.stringify(f, null, 2));
}

/** All-or-nothing: returns null unless every email has a recording, so a demo never mixes sources. */
export function loadFixtures(dir: string, emailIds: readonly string[]): { extractions: Record<string, ExtractedBackCharge[]>; model: string } | null {
  const out: Record<string, ExtractedBackCharge[]> = {};
  let model = "";
  for (const id of emailIds) {
    const p = join(dir, `${id}.json`);
    if (!existsSync(p)) return null;
    const f = JSON.parse(readFileSync(p, "utf8")) as Fixture;
    out[id] = f.items;
    model = f.model;
  }
  return { extractions: out, model };
}
