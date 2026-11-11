import type { InboxStatus } from "../server/gmail.ts";
import type { Status } from "../src/view.ts";

/** The label carries the meaning; tone only decorates. */
export const StatusWord = ({ s }: { s: Status }) => <span className={`status ${s.tone}`}>{s.label}</span>;
export const Badge = ({ children, testId }: { children: React.ReactNode; testId?: string }) => (
  <span className="badge" data-testid={testId}>
    {children}
  </span>
);
export const SimRamp = () => <Badge testId="simulated-ramp">Simulated Ramp</Badge>;
export const SampleData = () => <Badge testId="sample-data">Sample data</Badge>;

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
