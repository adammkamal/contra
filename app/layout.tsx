import type { Metadata } from "next";
import Link from "next/link";
import { ActionButton, ResetDemoButton } from "../ui/ActionButton.tsx";
import { API_BASE, apiDownMessage, chosenWorkspace, getHealth, getScreens } from "../ui/api.ts";
import { Badge, inboxWords, SampleData } from "../ui/Bits.tsx";
import { LiveUpdates } from "../ui/LiveUpdates.tsx";
import { WorkspaceSwitch } from "../ui/WorkspaceSwitch.tsx";
import "./globals.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Contra" };

const NAV = [
  ["/", "Missed back-charges"],
  ["/inbox", "Inbox"],
  ["/outbox", "Outbox"],
  ["/credits", "Credits & bills"],
  ["/pm-queue", "PM queue"],
  ["/audit", "Audit log"],
  ["/try", "Try any email"],
] as const;

export default async function Layout({ children }: { children: React.ReactNode }) {
  const ws = await chosenWorkspace();
  const health = await getHealth();
  if (!health.ok && health.down) {
    return (
      <Shell>
        <main>
          <div className="card danger" role="alert" data-testid="api-down">
            <h1>The API isn't running</h1>
            <p>{apiDownMessage()}</p>
            <p className="meta">This page reconnects on its own once the API is up.</p>
          </div>
          <LiveUpdates base={API_BASE} workspace={ws} />
        </main>
      </Shell>
    );
  }
  const liveAvailable = health.ok && health.data.workspaces.includes("live");
  const screens = await getScreens(ws);
  const s = screens.ok ? screens.data : null;
  const inbox = health.ok ? health.data.inbox : null;
  const words = ws === "live" && inbox ? inboxWords(inbox) : null;
  return (
    <Shell>
      <header className="presenter">
        <WorkspaceSwitch current={ws} liveAvailable={liveAvailable} />
        {ws === "demo" ? <SampleData /> : <Badge testId="live-badge">Live inbox</Badge>}
        <div className="step" data-testid="next-step">
          <span className="label">Next step</span>
          <span data-testid="next-step-text">{s ? s.nextStep.text : "—"}</span>
        </div>
        {s?.nextStep.action && <ActionButton action={s.nextStep.action} next={s.nextStep.action} prefix="presenter-" />}
        {s && <span className="clock">{s.now}</span>}
        {ws === "demo" && <ResetDemoButton />}
        <LiveUpdates base={API_BASE} workspace={ws} />
      </header>
      {words && inbox && (
        <div className="inbox-status" data-testid="inbox-status">
          <span>
            Intake address: <strong data-testid="intake-address">{inbox.address ?? "none"}</strong>
          </span>
          <span>
            Inbox: <strong className={`status ${words.tone}`} data-testid="inbox-word">{words.word}</strong>
            {words.detail && <span className="meta"> ({words.detail})</span>}
          </span>
          {inbox.modelCalls && (
            <span className="meta">
              Model calls today: {inbox.modelCalls.today} of {inbox.modelCalls.cap}
            </span>
          )}
          {inbox.lastPollAt && <span className="meta">Last checked {inbox.lastPollAt.slice(11, 19)} UTC</span>}
        </div>
      )}
      <nav>
        {NAV.map(([href, label]) => (
          <Link key={href} href={href}>
            {label}
          </Link>
        ))}
      </nav>
      <main>
        {!health.ok && (
          <p className="card danger" role="alert">
            The API answered {health.status}: {health.error}
          </p>
        )}
        {!screens.ok && !screens.down && (
          <p className="card danger" role="alert" data-testid="screens-error">
            {screens.error}
          </p>
        )}
        {!screens.ok && screens.down && (
          <p className="card danger" role="alert" data-testid="api-down">
            {apiDownMessage()}
          </p>
        )}
        {children}
      </main>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
