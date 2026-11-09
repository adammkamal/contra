/**
 * Writes fixtures/emails/E-1.eml .. E-3.eml from the demo seed's PM emails (sample data, not real mail).
 *   npx tsx scripts/make-eml.ts
 * Three encodings on purpose, so the reader is exercised on each:
 *   E-1  text/plain, quoted-printable with soft line breaks (one falls inside an amount sentence)
 *   E-2  text/html only (no plain part): the reader must fall back to the HTML's text
 *   E-3  text/plain, 7bit
 * E-4 (the sub's reply) is built at runtime from the sent notice, so there is no file for it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { demoSeed } from "../src/seed.ts";
import type { Email } from "../src/types.ts";

/** Fixed base date, the same one the tests use, so the files are byte-for-byte reproducible. */
export const EML_BASE = new Date("2026-11-07T15:00:00Z");

const CRLF = "\r\n";
const lines = (body: string) => body.split(/\r?\n/);

/** RFC 2045 quoted-printable: lines of at most 76 characters, "=" at the end of a soft break. */
export function encodeQuotedPrintable(text: string, width = 72): string {
  const hard = lines(text).map((line) => {
    const bytes = Buffer.from(line, "utf8");
    const tokens: string[] = [];
    bytes.forEach((b, i) => {
      const last = i === bytes.length - 1;
      const printable = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
      tokens.push(printable ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`);
    });
    const out: string[] = [];
    let cur = "";
    for (const t of tokens) {
      if (cur.length + t.length > width) {
        out.push(cur + "=");
        cur = "";
      }
      cur += t;
    }
    out.push(cur);
    return out.join(CRLF);
  });
  return hard.join(CRLF);
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Paragraphs on blank lines, <br> on single line breaks. Nothing else, so the text survives conversion. */
export function toHtml(body: string): string {
  const paras = body.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((p) => `<p>${p.split("\n").map(escapeHtml).join("<br>")}</p>`);
  return `<html><body>${paras.join(CRLF)}</body></html>`;
}

type Encoding = "quoted-printable" | "html" | "7bit";

export function buildEml(e: Email, encoding: Encoding): string {
  const headers = [
    `From: ${e.from}`,
    `To: ${e.to}`,
    `Subject: ${e.subject}`,
    `Date: ${e.receivedAt.toUTCString()}`,
    `Message-ID: <${e.id}.sample@apexbuilders.example>`,
    "MIME-Version: 1.0",
  ];
  let body: string;
  if (encoding === "quoted-printable") {
    headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable");
    body = encodeQuotedPrintable(e.body);
  } else if (encoding === "html") {
    headers.push("Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: 7bit");
    body = toHtml(e.body);
  } else {
    headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 7bit");
    body = lines(e.body).join(CRLF);
  }
  return headers.join(CRLF) + CRLF + CRLF + body + CRLF;
}

export const ENCODINGS: Record<string, Encoding> = { "E-1": "quoted-printable", "E-2": "html", "E-3": "7bit" };

/** The files make-eml writes, as { filename: contents }. */
export function emlFiles(base = EML_BASE): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of demoSeed(base).emails) out[`${e.id}.eml`] = buildEml(e, ENCODINGS[e.id] ?? "7bit");
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = join("fixtures", "emails");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(emlFiles())) {
    writeFileSync(join(dir, name), text, "utf8");
    console.log(`wrote ${join(dir, name)}`);
  }
}
