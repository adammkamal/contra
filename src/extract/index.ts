import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Actor, Email, ExtractedBackCharge, ExtractedResponse } from "../types.ts";
import { callTool, type CallOptions, type ModelSettings } from "./anthropic.ts";
import { BACKCHARGE_TOOL, RESPONSE_TOOL, backchargeSystem, responseSystem } from "./prompt.ts";
import { parseBackCharges, parseResponse, type Rejected } from "./validate.ts";

export interface ExtractOptions extends CallOptions {
  /** Source of the per-call wrapper id. Default: a random UUID without dashes. Tests inject a fixed one. */
  boundary?: () => string;
}

const randomBoundary = () => randomUUID().replace(/-/g, "");

/**
 * Wraps the email in <email_{random}> ... </email_{random}>, a tag name the email's author can't know,
 * so a body containing "</email>" (or any other tag) stays inside. Redraws if the email happens to
 * contain the tag name; refuses after a few tries rather than send an ambiguous wrapper.
 */
export function wrap(e: Email, boundary: () => string = randomBoundary): { tag: string; text: string } {
  const content = `From: ${e.from}\nTo: ${e.to}\nSubject: ${e.subject}\n\n${e.body}`;
  for (let i = 0; i < 5; i++) {
    const b = boundary();
    if (!/^[A-Za-z0-9]{8,64}$/.test(b)) throw new Error("email boundary must be 8-64 letters or digits");
    const tag = `email_${b}`;
    if (content.includes(tag) || e.id.includes(tag)) continue;
    return { tag, text: `<${tag} id="${e.id}">\n${content}\n</${tag}>` };
  }
  throw new Error("could not choose an email boundary that the email does not contain");
}

export async function extractBackCharges(
  settings: ModelSettings,
  email: Email,
  opts: ExtractOptions = {},
): Promise<{ ok: true; items: ExtractedBackCharge[]; rejected: Rejected[]; actor: Actor } | { ok: false; reason: string }> {
  const w = wrap(email, opts.boundary);
  const r = await callTool(settings, { system: backchargeSystem(w.tag), user: w.text, tool: BACKCHARGE_TOOL }, opts);
  if (r.status !== "OK") return { ok: false, reason: `${r.status}: ${r.message}` };
  const parsed = parseBackCharges(r.toolInput, email);
  return { ok: true, ...parsed, actor: { kind: "llm", id: "extractor", model: r.model } };
}

export async function extractResponse(
  settings: ModelSettings,
  email: Email,
  notice: { id: string; backChargeRefs: readonly string[] },
  opts: ExtractOptions = {},
): Promise<{ ok: true; value: ExtractedResponse; actor: Actor } | { ok: false; reason: string }> {
  const w = wrap(email, opts.boundary);
  const user = `Notice ${notice.id} listed: ${notice.backChargeRefs.join(", ")}\n\n${w.text}`;
  const r = await callTool(settings, { system: responseSystem(w.tag), user, tool: RESPONSE_TOOL }, opts);
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
