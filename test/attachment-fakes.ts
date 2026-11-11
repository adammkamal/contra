/**
 * Builds the files the attachment tests need, in the tests: PDFs with text on chosen pages (pdf-lib),
 * scanned-style PDFs (an image and no text layer), PNGs of any size, and multipart .eml messages.
 */
import { crc32, deflateSync } from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";

/** A PDF with one page per entry, each line drawn as text (so it has a text layer). */
export async function textPdf(pages: readonly (readonly string[])[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const p = doc.addPage([612, 792]);
    lines.forEach((l, i) => p.drawText(l, { x: 50, y: 740 - i * 18, size: 11, font }));
  }
  return doc.save();
}

/** A PDF whose pages are only an image (no text layer): what a scanner produces. */
export async function scannedPdf(pageCount = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(png(40, 20));
  for (let i = 0; i < pageCount; i++) doc.addPage([612, 792]).drawImage(img, { x: 50, y: 500, width: 400, height: 200 });
  return doc.save();
}

/** A valid grey PNG of the given size. */
export function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const row = Buffer.alloc(1 + width, 0x80);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export interface Part {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

/** A multipart/mixed message: a text/plain body, then each part as a base64 attachment. `inline` parts go in a multipart/related with an HTML body that shows them by cid. */
export function eml(o: { id?: string; subject: string; body: string; parts?: readonly Part[]; inline?: readonly Part[] }): Buffer {
  const b64 = (d: Uint8Array) => Buffer.from(d).toString("base64").replace(/.{1,76}/g, "$&\r\n");
  const lines = [
    `Message-ID: <${o.id ?? "att-test"}@pm.example>`,
    "Date: Tue, 10 Nov 2026 15:00:00 +0000",
    "From: Dana Ortiz <dana.ortiz@apexbuilders.example>",
    "To: Ridgeline Interiors LLC <ap@ridgelineinteriors.example>",
    `Subject: ${o.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="mix"',
    "",
    "--mix",
  ];
  if (o.inline?.length) {
    lines.push('Content-Type: multipart/related; boundary="rel"', "", "--rel", "Content-Type: text/plain; charset=utf-8", "", o.body);
    lines.push("--rel", "Content-Type: text/html; charset=utf-8", "", `<p>${o.body.replace(/\n/g, "<br>")}</p>${o.inline.map((p, i) => `<img src="cid:img${i}">`).join("")}`);
    o.inline.forEach((p, i) => lines.push("--rel", `Content-Type: ${p.contentType}`, `Content-ID: <img${i}>`, `Content-Disposition: inline; filename="${p.filename}"`, "Content-Transfer-Encoding: base64", "", b64(p.data)));
    lines.push("--rel--");
  } else {
    lines.push("Content-Type: text/plain; charset=utf-8", "", o.body);
  }
  for (const p of o.parts ?? []) {
    lines.push("--mix", `Content-Type: ${p.contentType}`, `Content-Disposition: attachment; filename="${p.filename}"`, "Content-Transfer-Encoding: base64", "", b64(p.data));
  }
  lines.push("--mix--", "");
  return Buffer.from(lines.join("\r\n"), "utf8");
}
