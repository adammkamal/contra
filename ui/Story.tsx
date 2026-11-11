import Link from "next/link";
import type { Screens } from "../src/view.ts";
import { StatusWord } from "./Bits.tsx";

/**
 * The demo so far, in four places: emails read, the notice, the credit, the bill. Every figure and status
 * word is the backend's own string; this only decides where each one sits. Inbox amounts are left out on
 * purpose (an amount read from a photo stays hidden until the PM confirms it).
 */
export function Story({ s }: { s: Screens }) {
  const taken = s.inbox.filter((r) => r.kind === "backCharge").length;
  const refused = s.inbox.length - taken;
  return (
    <section className="story" aria-label="The demo so far">
      <Link href="/inbox" className={s.inbox.length ? "story-cell" : "story-cell empty"}>
        <span className="story-label">PM emails read</span>
        {s.inbox.length ? (
          <>
            <span className="story-value">
              {taken} {taken === 1 ? "back-charge" : "back-charges"}
            </span>
            <span className="story-note">{refused ? `${refused} not taken in, held for a person` : "Each with the sentence it came from"}</span>
          </>
        ) : (
          <span className="story-value">None yet</span>
        )}
      </Link>

      <Link href="/outbox" className={s.outbox.length ? "story-cell" : "story-cell empty"}>
        <span className="story-label">Notice to the sub</span>
        {s.outbox.length ? (
          s.outbox.map((n) => (
            <span key={n.id} className="story-note">
              <span className="story-value">{n.total}</span>
              <br />
              <StatusWord s={n.status} />
            </span>
          ))
        ) : (
          <span className="story-value">None yet</span>
        )}
      </Link>

      <Link href="/credits" className={s.credits.length ? "story-cell" : "story-cell empty"}>
        <span className="story-label">Vendor credit</span>
        {s.credits.length ? (
          s.credits.map((c) => (
            <span key={c.id} className="story-note">
              <span className="story-value">{c.amount}</span>
              <br />
              <StatusWord s={c.status} />
            </span>
          ))
        ) : (
          <span className="story-value">None yet</span>
        )}
      </Link>

      <Link href="/credits" className={s.bills.length ? "story-cell" : "story-cell empty"}>
        <span className="story-label">Bill in simulated Ramp</span>
        {s.bills.length ? (
          s.bills.map((b) => (
            <span key={b.id} className="story-note">
              <span className="story-value">{b.paid ?? b.amount}</span>
              <br />
              <StatusWord s={b.status} />
              {b.paid ? (
                <>
                  <br />
                  on a {b.amount} bill
                </>
              ) : null}
            </span>
          ))
        ) : (
          <span className="story-value">None yet</span>
        )}
      </Link>
    </section>
  );
}
