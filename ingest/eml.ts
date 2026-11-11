/**
 * Reads .eml files into the core's Email type. Lives outside src/ because it uses a dependency
 * (mailparser); src/ only ever sees the resulting Email objects.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { simpleParser, type AddressObject } from "mailparser";
import type { PmEmailSource } from "../src/commands.ts";
import type { Email } from "../src/types.ts";

export class EmlError extends Error {}

/** "Name <addr>" when the header has a display name, else just the address. Group headers are flattened. */
function address(h: AddressObject | AddressObject[] | undefined, header: string): string {
  const list = (Array.isArray(h) ? h : h ? [h] : []).flatMap((a) => a.value);
  const out = list.map((a) => (a.name ? `${a.name} <${a.address ?? ""}>` : a.address ?? "")).filter((s) => s.length > 0);
  if (out.length === 0) throw new EmlError(`missing ${header} header`);
  return out.join(", ");
}

/**
 * Parses one RFC 822 message. Body: the text/plain part when there is one, else mailparser's text
 * rendering of the HTML part. Line endings are normalized to \n. The Date header is required: an
 * email with no date can't be placed on the timeline, so it is rejected rather than guessed.
 * messageId (the Message-ID header) and attachmentCount are set when present; attachments aren't read.
 */
export async function parseEml(bytes: Buffer | Uint8Array, id: string): Promise<Email> {
  const m = await simpleParser(Buffer.from(bytes), { skipImageLinks: true });
  if (!m.date || !m.headers.has("date")) throw new EmlError(`${id}: missing Date header`);
  if (Number.isNaN(m.date.getTime())) throw new EmlError(`${id}: unreadable Date header`);
  const text = typeof m.text === "string" && m.text.trim() !== "" ? m.text : "";
  if (!text) throw new EmlError(`${id}: no text/plain or HTML body`);
  const attachments = m.attachments?.length ?? 0;
  return {
    id,
    from: address(m.from, "From"),
    to: address(m.to, "To"),
    subject: m.subject ?? "",
    receivedAt: m.date,
    body: text.replace(/\r\n?/g, "\n").replace(/\n+$/, ""),
    // Only when present, so emails without them keep their exact shape.
    ...(m.messageId ? { messageId: m.messageId } : {}),
    ...(attachments ? { attachmentCount: attachments } : {}),
  };
}

/**
 * Every *.eml in `dir`, sorted by filename, with the filename (minus .eml) as the email id so recorded
 * extractions keyed by id still apply. Returns null when the folder doesn't exist or has no .eml files.
 */
export async function loadEmlDir(dir: string): Promise<Email[] | null> {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".eml")).sort();
  if (files.length === 0) return null;
  return Promise.all(files.map((f) => parseEml(readFileSync(join(dir, f)), basename(f, ".eml"))));
}

export const DEFAULT_EML_DIR = "fixtures/emails";

/**
 * What hosts pass to runAction as `{ pmEmails }`: the .eml files in `dir` when the folder has any,
 * else null (runAction then uses the built-in sample). Throws EmlError if a file can't be read.
 */
export async function loadPmEmails(dir: string = DEFAULT_EML_DIR): Promise<PmEmailSource | null> {
  const emails = await loadEmlDir(dir);
  return emails ? { origin: "eml", emails } : null;
}
