import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Actor, AttachmentMedia, Email, ExtractedBackCharge, ExtractedResponse } from "../types.ts";
import { callTool, type CallOptions, type CallResult, type ContentBlock, type ModelSettings } from "./anthropic.ts";
import { BACKCHARGE_TOOL, BACKCHARGE_TOOL_WITH_ATTACHMENTS, RESPONSE_TOOL, attachmentRules, backchargeSystem, responseSystem } from "./prompt.ts";
import { parseBackCharges, parseResponse, type Rejected } from "./validate.ts";

/** Why a model call failed, as callTool classifies it. */
export type CallErrorType = Exclude<CallResult["status"], "OK">;

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

/** A filename as an attribute value: no quotes, angle brackets, ampersands or line breaks, at most 120 characters. */
const attr = (s: string) => s.replace(/["<>&\p{Cc}]/gu, "_").slice(0, 120);

/**
 * The back-charge extraction input. Without attachments that were read: exactly wrap(email), a string.
 * With them: content blocks. First each photo or scanned PDF (from `media`), each after a label
 * <attachment_{b} n=".." filename=".."> naming it (the API docs advise images before text); then one text
 * block with the email, followed by one <attachment_{b}> section per PDF read as text, one <page_{b}> per
 * page, each separate from the body. The boundary id `b` is the same random one as the email's tag, and
 * is redrawn if any of that text contains it. An image attachment without media is left out.
 */
export function backChargeInput(
  e: Email,
  media: readonly AttachmentMedia[] = [],
  boundary: () => string = randomBoundary,
): { tag: string; id: string; user: string | ContentBlock[]; withAttachments: boolean } {
  const textAtts = (e.attachments ?? []).filter((a) => a.read === "text");
  const imageAtts = (e.attachments ?? []).filter((a) => a.read === "image" && media.some((m) => m.n === a.n));
  if (textAtts.length === 0 && imageAtts.length === 0) {
    const w = wrap(e, boundary);
    return { tag: w.tag, id: w.tag.slice("email_".length), user: w.text, withAttachments: false };
  }
  const extra = [...textAtts.flatMap((a) => [a.filename, ...(a.pages ?? [])]), ...imageAtts.map((a) => a.filename)].join("\n");
  for (let i = 0; i < 5; i++) {
    const w = wrap(e, boundary);
    const b = w.tag.slice("email_".length);
    if (extra.includes(b)) continue;
    const sections = textAtts.map((a) =>
      [
        `<attachment_${b} n="${a.n}" filename="${attr(a.filename)}" kind="PDF read as text" pages="${a.pages?.length ?? 0}">`,
        ...(a.pages ?? []).map((p, j) => `<page_${b} n="${j + 1}">\n${p}\n</page_${b}>`),
        `</attachment_${b}>`,
      ].join("\n"),
    );
    const blocks: ContentBlock[] = imageAtts.flatMap((a) => {
      const m = media.find((x) => x.n === a.n)!;
      const kind = m.mediaType === "application/pdf" ? `scanned PDF, ${a.pageCount ?? "?"} pages` : "photo";
      const label: ContentBlock = { type: "text", text: `<attachment_${b} n="${a.n}" filename="${attr(a.filename)}" kind="${kind}">` };
      const data = Buffer.from(m.data).toString("base64");
      const block: ContentBlock =
        m.mediaType === "application/pdf"
          ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
          : { type: "image", source: { type: "base64", media_type: m.mediaType, data } };
      return [label, block];
    });
    blocks.push({ type: "text", text: [w.text, ...sections].join("\n") });
    return { tag: w.tag, id: b, user: blocks, withAttachments: true };
  }
  throw new Error("could not choose an email boundary that the email does not contain");
}

export async function extractBackCharges(
  settings: ModelSettings,
  email: Email,
  opts: ExtractOptions & { media?: readonly AttachmentMedia[] } = {},
): Promise<{ ok: true; items: ExtractedBackCharge[]; rejected: Rejected[]; actor: Actor; rawToolInput: unknown } | { ok: false; reason: string; errorType: CallErrorType }> {
  const w = backChargeInput(email, opts.media, opts.boundary);
  const system = w.withAttachments ? `${backchargeSystem(w.tag)}\n${attachmentRules(w.id)}` : backchargeSystem(w.tag);
  const r = await callTool(settings, { system, user: w.user, tool: w.withAttachments ? BACKCHARGE_TOOL_WITH_ATTACHMENTS : BACKCHARGE_TOOL }, opts);
  if (r.status !== "OK") return { ok: false, reason: `${r.status}: ${r.message}`, errorType: r.status };
  const parsed = parseBackCharges(r.toolInput, email);
  // rawToolInput is the model's output before validation, so recordings can be re-validated later.
  return { ok: true, ...parsed, actor: { kind: "llm", id: "extractor", model: r.model }, rawToolInput: r.toolInput };
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
