/**
 * Reads a PM email's attachments for extraction. Lives outside src/ because it uses a dependency
 * (pdfjs-dist); src/ only ever sees text and decisions (EmailAttachment), and the model call gets the
 * bytes of photos and scans (AttachmentMedia), which are never stored.
 *
 * - A PDF with a text layer on every page: each page's text is extracted here, so every sentence the
 *   model cites from it is verified against this text, like the body. The model gets the text, not the PDF.
 * - A photo (JPEG, PNG, GIF, WebP), or a PDF with a page without a text layer (a scan): sent to the model as
 *   an image or document. Nothing read from it can be verified word for word (src/intake.ts holds it).
 * - Anything else, or over a limit: skipped, with the reason in words. Never dropped silently.
 *
 * Limits (ours): at most 5 PDFs and images per email, each at most 10 MB, a PDF at most 20 pages.
 * Limits (the Claude API, checked 2026-11-10 at platform.claude.com/docs/en/build-with-claude/vision and
 * .../pdf-support): images JPEG/PNG/GIF/WebP, at most 10 MB base64-encoded each, at most 8000x8000 px;
 * PDFs without passwords or encryption; requests at most 128 MB and 100 PDF pages under a 1M context
 * (5 x 20 pages and 5 x 10 MB stay inside both).
 */
import type { AttachmentMedia, EmailAttachment } from "../src/types.ts";

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 20;
/** The API takes an image of at most 10 MB base64-encoded (counted as 10,000,000 characters to be safe): 7,500,000 bytes before encoding. */
export const MAX_IMAGE_BYTES = 7_500_000;
export const MAX_IMAGE_SIDE = 8000;
/** An image embedded in the HTML (by cid) and smaller than this is taken for a logo or signature and not read. */
export const INLINE_LOGO_BYTES = 50 * 1024;

/** One attachment as the mail parser gives it. */
export interface RawAttachment {
  filename?: string;
  contentType: string;
  content: Uint8Array;
  /** Referenced from the HTML body by a cid (mailparser's `related`): signature logos, pasted images. */
  related?: boolean;
}

type ImageType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const mb = (n: number) => `${(Math.ceil((n / (1024 * 1024)) * 10) / 10).toString()} MB`;

/** The image type from the file's first bytes, or null. The declared Content-Type is not trusted. */
export function sniffImage(b: Uint8Array): ImageType | null {
  const s = (i: number, str: string) => [...str].every((c, j) => b[i + j] === c.charCodeAt(0));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (s(0, "\x89PNG\r\n\x1a\n")) return "image/png";
  if (s(0, "GIF87a") || s(0, "GIF89a")) return "image/gif";
  if (s(0, "RIFF") && s(8, "WEBP")) return "image/webp";
  return null;
}

const isPdf = (b: Uint8Array) => {
  // "%PDF-" within the first 1 KB (some writers put bytes before it).
  const head = Buffer.from(b.subarray(0, 1024)).toString("latin1");
  return head.includes("%PDF-");
};

/** Width and height from the image header, or null when they can't be read. */
export function imageSize(b: Uint8Array, type: ImageType): { width: number; height: number } | null {
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
  const u32be = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
  if (b.length < 30) return null;
  if (type === "image/png") return { width: u32be(16), height: u32be(20) };
  if (type === "image/gif") return { width: u16le(6), height: u16le(8) };
  if (type === "image/webp") {
    const chunk = Buffer.from(b.subarray(12, 16)).toString("latin1");
    if (chunk === "VP8 ") return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    return null;
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: u16be(i + 7), height: u16be(i + 5) };
    i += 2 + u16be(i + 2);
  }
  return null;
}

/** Each page's text from the PDF's text layer (lines kept), or why it can't be read. */
export async function pdfPages(data: Uint8Array, maxPages = MAX_PDF_PAGES): Promise<{ ok: true; pages: string[] } | { ok: false; reason: string; pageCount?: number }> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // A copy: pdfjs takes ownership of the buffer it is given.
  const task = getDocument({ data: new Uint8Array(data), useSystemFonts: false, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    void task.destroy();
    const name = e && typeof e === "object" && "name" in e ? String(e.name) : "";
    return { ok: false, reason: name === "PasswordException" ? "the PDF is password-protected or encrypted, which the model can't read" : "the PDF could not be read (damaged, or not a PDF)" };
  }
  try {
    if (doc.numPages > maxPages) return { ok: false, reason: `the PDF has ${doc.numPages} pages, over the limit of ${maxPages}`, pageCount: doc.numPages };
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      pages.push(
        tc.items
          .map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : ""))
          .join("")
          .replace(/[ \t]+\n/g, "\n")
          .trimEnd(),
      );
    }
    return { ok: true, pages };
  } catch {
    return { ok: false, reason: "the PDF could not be read (damaged, or not a PDF)" };
  } finally {
    void task.destroy();
  }
}

/**
 * What to do with each attachment, in message order, numbered from 1. Pure apart from reading PDFs.
 * Only the first MAX_ATTACHMENTS PDFs and images are read; files of any other type, and small images
 * embedded in the HTML (logos), don't count toward that limit and are listed as skipped.
 */
export async function readAttachments(raw: readonly RawAttachment[]): Promise<{ attachments: EmailAttachment[]; media: AttachmentMedia[] }> {
  const attachments: EmailAttachment[] = [];
  const media: AttachmentMedia[] = [];
  let candidates = 0;
  for (const [i, a] of raw.entries()) {
    const n = i + 1;
    const filename = (a.filename ?? "").replace(/[\p{Cc}]/gu, " ").trim().slice(0, 200) || `attachment-${n}`;
    const bytes = a.content;
    const image = sniffImage(bytes);
    const pdf = !image && isPdf(bytes);
    const mediaType = image ?? (pdf ? "application/pdf" : a.contentType.toLowerCase().split(";")[0]!.trim() || "application/octet-stream");
    const skip = (reason: string) => attachments.push({ n, filename, mediaType, read: "skipped", reason });

    if (!image && !pdf) {
      skip(
        a.contentType.toLowerCase().startsWith("image/")
          ? `${mediaType} is not an image type the model reads (JPEG, PNG, GIF or WebP); send the photo as a JPEG`
          : `not a PDF or a photo (${mediaType})`,
      );
      continue;
    }
    if (image && a.related && bytes.length < INLINE_LOGO_BYTES) {
      skip(`a small image embedded in the email's HTML (${mb(bytes.length)}), taken for a logo or signature`);
      continue;
    }
    candidates++;
    if (candidates > MAX_ATTACHMENTS) {
      skip(`only the first ${MAX_ATTACHMENTS} PDFs and photos in an email are read`);
      continue;
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      skip(`larger than 10 MB (${mb(bytes.length)})`);
      continue;
    }
    if (image) {
      if (bytes.length > MAX_IMAGE_BYTES) {
        skip(`a ${mb(bytes.length)} photo is over the model's limit (10 MB once encoded, about 7.1 MB); send a smaller size`);
        continue;
      }
      const size = imageSize(bytes, image);
      if (!size || size.width < 1 || size.height < 1) {
        skip("the image could not be read");
        continue;
      }
      if (size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE) {
        skip(`the image is ${size.width}x${size.height} px, over the model's limit of ${MAX_IMAGE_SIDE}x${MAX_IMAGE_SIDE}`);
        continue;
      }
      attachments.push({ n, filename, mediaType: image, read: "image" });
      media.push({ n, mediaType: image, data: bytes });
      continue;
    }
    const r = await pdfPages(bytes);
    if (!r.ok) {
      skip(r.reason);
      continue;
    }
    if (r.pages.every((p) => p.trim() !== "")) {
      attachments.push({ n, filename, mediaType: "application/pdf", read: "text", pages: r.pages });
    } else {
      // A scan, or a PDF with some scanned pages: the model reads the whole PDF, and nothing from it is
      // verified word for word (per PDF, not per page).
      attachments.push({ n, filename, mediaType: "application/pdf", read: "image", pageCount: r.pages.length });
      media.push({ n, mediaType: "application/pdf", data: bytes });
    }
  }
  return { attachments, media };
}
