import type { Metadata } from "next";
import Link from "next/link";
import { ActionButton, PlainButton } from "../ui/ActionButton.tsx";
import { screens } from "../ui/data.ts";
import "./globals.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Contra" };

const NAV = [
  ["/", "Missed back-charges"], ["/inbox", "Inbox"], ["/outbox", "Outbox"],
  ["/credits", "Credits & bills"], ["/pm-queue", "PM queue"], ["/audit", "Audit log"],
] as const;

export default function Layout({ children }: { children: React.ReactNode }) {
  const s = screens();
  const { text, action } = s.nextStep;
  // nextStep has no action for the first step (nothing ingested) and the last ("Demo complete").
  const ingest = action === null && s.inbox.length === 0;
  return (
    <html lang="en">
      <body>
        <header className="presenter">
          <div className="step"><span className="label">Next step</span>{text}</div>
          {action && <ActionButton action={action} next={action} prefix="presenter-" />}
          {ingest && <PlainButton kind="ingest" highlight />}
          <span className="clock">{s.now}</span>
          <PlainButton kind="reset" />
        </header>
        <nav>{NAV.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}</nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
