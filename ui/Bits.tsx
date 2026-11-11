import type { InboxStatus } from "../server/gmail.ts";
import type { Status } from "../src/view.ts";

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
// The server withholds the model's reading until a person confirms the amount (amount and sourceSentence are
// "" until then; photoAmount carries both readings afterwards). The UI only renders what it is given.

export const IMAGE_READING_LABEL = "Model's reading of the photo, not checked word for word";

/** "PM entered $640.00 (model read $604.00 from the photo)" when the two differ; null when they agree. */
export const photoAmountNote = (p: { pmEntered: string; modelRead: string }) => (p.pmEntered === p.modelRead ? null : `PM entered ${p.pmEntered} (model read ${p.modelRead} from the photo)`);

/** A reading from an image: its own label and style (dashed, italic), never the verified quote style. */
export function ImageReading({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <div className="reading" data-testid={testId}>
      <div className="reading-label">{IMAGE_READING_LABEL}</div>“{children}”
    </div>
  );
}
