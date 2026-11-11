import type { InboxStatus } from "../server/gmail.ts";
import type { Screens, Status } from "../src/view.ts";

/** The label carries the meaning; tone only decorates (a colour and a small shape before the word). */
export const StatusWord = ({ s }: { s: Status }) => <span className={`status ${s.tone}`}>{s.label}</span>;
export const Badge = ({ children, testId, live = false }: { children: React.ReactNode; testId?: string; live?: boolean }) => (
  <span className={live ? "badge live" : "badge"} data-testid={testId}>
    {children}
  </span>
);
export const SimRamp = () => <Badge testId="simulated-ramp">Simulated Ramp</Badge>;
export const SampleData = () => <Badge testId="sample-data">Sample data</Badge>;

/** The Contra mark: two equal bars, the lower one shifted, overlapping where the amounts cancel. */
export const Mark = () => (
  <svg className="brand-mark" viewBox="0 0 34 34" aria-hidden="true" focusable="false">
    <rect className="bar-a" x="2" y="6" width="22" height="10" rx="3" />
    <rect className="bar-b" x="10" y="18" width="22" height="10" rx="3" />
  </svg>
);

/** A sentence that was checked word for word against its source: the only text that gets the highlighter. */
export const Quote = ({ children }: { children: React.ReactNode }) => (
  <div className="quote">
    <span className="hl">“{children}”</span>
  </div>
);

/** How the PM's words were linked to a subcontract, one step per line, as the backend wrote them. */
export function Chain({ steps, empty }: { steps: readonly string[]; empty: string }) {
  if (steps.length === 0) return <p className="meta">{empty}</p>;
  return (
    <ol className="chain">
      {steps.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ol>
  );
}

/** Each attachment in the backend's own words, skipped ones included. */
export function Files({ items, testId }: { items: readonly string[]; testId?: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="files" data-testid={testId}>
      {items.map((a, i) => (
        <li key={i}>{a}</li>
      ))}
    </ul>
  );
}

const VERDICT = /^(PASS|HOLD|WAIT) (.*)$/s;
/** Eligibility trace lines begin PASS, HOLD or WAIT. The word stays; it only gets its own column and a colour. */
export function Trace({ lines }: { lines: readonly string[] }) {
  return (
    <ul className="trace">
      {lines.map((t, i) => {
        const m = VERDICT.exec(t);
        return m ? (
          <li key={i} className={m[1]!.toLowerCase()}>
            <span className="verdict">{m[1]}</span> <span>{m[2]}</span>
          </li>
        ) : (
          <li key={i}>
            <span />
            <span>{t}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Offsets of `sentence` in `body`, with runs of whitespace treated as equal (an .eml's HTML part is re-wrapped). */
export function findSentence(body: string, sentence: string): [number, number] | null {
  const words = sentence.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const m = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")).exec(body);
  return m ? [m.index, m.index + m[0].length] : null;
}

/** The text with [start, end) marked. */
export function Marked({ text, range }: { text: string; range: [number, number] | null }) {
  if (!range) return <>{text}</>;
  const [a, b] = range;
  return (
    <>
      {text.slice(0, a)}
      <mark data-testid="highlight">{text.slice(a, b)}</mark>
      {text.slice(b)}
    </>
  );
}

/** The live inbox's status from /api/health, as a plain word first, then the API's own text. */
export function inboxWords(i: InboxStatus): { word: string; detail: string; tone: Status["tone"] } {
  if (i.status === "ok") return { word: "Inbox OK", detail: i.address ? `reading ${i.address}` : "", tone: "ok" };
  if (i.status.startsWith("expired")) return { word: "Sign-in expired", detail: i.status, tone: "danger" };
  if (i.status.startsWith("paused")) return { word: "Paused: daily cap reached", detail: i.status, tone: "warn" };
  if (i.status.startsWith("not configured")) return { word: "Not configured", detail: i.status, tone: "danger" };
  if (i.status === "error") return { word: "Inbox error", detail: i.lastError ?? "", tone: "danger" };
  if (i.status === "starting") return { word: "Starting", detail: "the first poll hasn't finished yet", tone: "idle" };
  return { word: i.status, detail: i.lastError ?? "", tone: "idle" };
}

// ---- Text read from a photo or scanned page --------------------------------------------------------------
// The model's reading of an image can't be checked word for word. It is never shown as if it were checked
// (the plain quote style and the highlight are for verified text only), and it is not shown at all until the
// PM has typed the amount they see. The screens carry no structured "model read" field, so this reads the
// audit entry that confirmImageAmount writes ("PM entered $640.00; model read $604.00" plus the sentence).

type Row = Screens["inbox"][number];
type AuditRow = Screens["audit"][number];

export const IMAGE_READING_LABEL = "Model's reading of the photo, not checked word for word";

/** True when the row's sentence came from a photo or scanned page (its attachment line says it was read as an image). */
export function isFromImage(r: Pick<Row, "kind" | "sourceLocation" | "attachments">): boolean {
  if (r.kind !== "backCharge" || r.sourceLocation === "email body") return false;
  const file = r.sourceLocation.replace(/^attachment /, "").replace(/, page \d+$/, "");
  return r.attachments.some((a) => a.startsWith(`attachment ${file}: `) && a.includes("read by the model as an image"));
}

const READ_PREFIX = "the model's reading of the image (not verifiable word for word): ";
const BOTH = /entered (\$[\d,]+\.\d\d); model read (\$[\d,]+\.\d\d)$/;

/** What the PM typed and what the model read, once the PM has confirmed this sentence; else null. */
export function findConfirmation(events: readonly Pick<AuditRow, "evidence">[], sentence: string): { entered: string; model: string } | null {
  for (const e of events) {
    if (!e.evidence.includes(READ_PREFIX + sentence)) continue;
    const m = e.evidence.map((x) => BOTH.exec(x)).find(Boolean);
    if (m) return { entered: m[1]!, model: m[2]! };
  }
  return null;
}

/** "PM entered $640.00 (model read $604.00 from the photo)" when they differ; null when they agree. */
export const differenceNote = (c: { entered: string; model: string }) => (c.entered === c.model ? null : `PM entered ${c.entered} (model read ${c.model} from the photo)`);

/** Sentences read from an image that no person has confirmed yet: shown nowhere. */
export function hiddenReadings(s: Screens): string[] {
  return s.inbox.filter((r) => isFromImage(r) && !findConfirmation(s.audit, r.sourceSentence)).map((r) => r.sourceSentence);
}

const HIDDEN_WORDS = "(the model's reading of the image is hidden until the PM confirms the amount)";
/**
 * Hides a reading in free text (audit lines, evidence, trace): text holding the sentence is replaced whole, and
 * any dollar amount from the sentence is blanked ("extracted $604.00" -> "extracted (hidden)"). It errs toward
 * hiding: another line with the same dollar string is blanked too.
 */
export function redact(text: string, hidden: readonly string[]): string {
  if (hidden.some((h) => h && text.includes(h))) return HIDDEN_WORDS;
  let out = text;
  for (const amt of new Set(hidden.flatMap((h) => h.match(/\$[\d,]+\.\d\d/g) ?? []))) out = out.split(amt).join("(hidden)");
  return out;
}

/** A reading from an image: its own label and style (dashed, italic), never the verified quote style. */
export function ImageReading({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <div className="reading" data-testid={testId}>
      <div className="reading-label">{IMAGE_READING_LABEL}</div>“{children}”
    </div>
  );
}
