import type { Metadata } from "next";
import Link from "next/link";
import { ActionButton, ResetDemoButton } from "../ui/ActionButton.tsx";
import { API_BASE, apiDownMessage, chosenWorkspace, getHealth, getScreens } from "../ui/api.ts";
import { Badge, inboxWords, Mark, SampleData } from "../ui/Bits.tsx";
import { LiveUpdates } from "../ui/LiveUpdates.tsx";
import { NavLinks, type NavGroup } from "../ui/NavLinks.tsx";
import { Story } from "../ui/Story.tsx";
import { WorkspaceSwitch } from "../ui/WorkspaceSwitch.tsx";
import "./globals.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Contra: back-charges that reach the bill",
  description: "A hackathon concept for Ramp Bill Pay. Every Ramp screen is simulated.",
};

/** Screens grouped by who uses them. `waiting` is how many rows the PM queue has. */
const nav = (waiting: number): NavGroup[] => [
  { name: "Start here", items: [{ href: "/", label: "Missed back-charges" }] },
  {
    name: "Project manager",
    items: [
      { href: "/inbox", label: "Inbox" },
      { href: "/outbox", label: "Outbox" },
      { href: "/pm-queue", label: "PM queue", count: waiting },
    ],
  },
  { name: "Controller and AP", items: [{ href: "/credits", label: "Credits & bills" }, { href: "/audit", label: "Audit log" }] },
  { name: "Anyone", items: [{ href: "/try", label: "Try any email" }] },
];

export default async function Layout({ children }: { children: React.ReactNode }) {
  const ws = await chosenWorkspace();
  // Health and screens don't depend on each other: ask for both at once.
  const [health, screens] = await Promise.all([getHealth(), getScreens(ws)]);
  if (!health.ok && health.down) {
    return (
      <Shell>
        <Rail groups={nav(0)} />
        <div className="stage">
          <div className="stage-inner">
            <main id="main">
              <div className="card danger" role="alert" data-testid="api-down">
                <div className="stack">
                  <h1>The API isn't running</h1>
                  <p>{apiDownMessage()}</p>
                  <p className="meta">Nothing was lost. This page reconnects on its own once the API is up.</p>
                </div>
              </div>
              <LiveUpdates base={API_BASE} workspace={ws} />
            </main>
          </div>
        </div>
      </Shell>
    );
  }
  const liveAvailable = health.ok && health.data.workspaces.includes("live");
  const s = screens.ok ? screens.data : null;
  const inbox = health.ok ? health.data.inbox : null;
  const words = ws === "live" && inbox ? inboxWords(inbox) : null;
  return (
    <Shell>
      <Rail
        groups={nav(s ? s.pmQueue.length : 0)}
        foot={
          <div className="rail-meta">
            {s ? (
              <span>
                Workspace clock: <span className="clock">{s.now}</span>
              </span>
            ) : null}
            <LiveUpdates base={API_BASE} workspace={ws} />
            {ws === "demo" ? <ResetDemoButton /> : null}
          </div>
        }
      >
        <WorkspaceSwitch current={ws} liveAvailable={liveAvailable} />
      </Rail>
      <div className="stage">
        <div className="stage-inner">
          <header className="presenter">
            {ws === "demo" ? (
              <SampleData />
            ) : (
              <Badge testId="live-badge" live>
                Live inbox
              </Badge>
            )}
            <div className="step" data-testid="next-step">
              <span className="label">Next step</span>
              <span className="step-text" data-testid="next-step-text">
                {s ? s.nextStep.text : "Not available"}
              </span>
            </div>
            {s?.nextStep.action ? <ActionButton action={s.nextStep.action} next={s.nextStep.action} prefix="presenter-" /> : null}
          </header>

          {words && inbox ? (
            <div className="inbox-status" data-testid="inbox-status">
              <span>
                Intake address: <strong data-testid="intake-address">{inbox.address ?? "none"}</strong>
              </span>
              <span>
                Inbox:{" "}
                <strong className={`status ${words.tone}`} data-testid="inbox-word">
                  {words.word}
                </strong>
                {words.detail ? <span className="meta"> ({words.detail})</span> : null}
              </span>
              {inbox.modelCalls ? (
                <span className="meta">
                  Model calls today: {inbox.modelCalls.today} of {inbox.modelCalls.cap}
                </span>
              ) : null}
              {inbox.lastPollAt ? <span className="meta">Last checked {inbox.lastPollAt.slice(11, 19)} UTC</span> : null}
            </div>
          ) : null}

          {s ? <Story s={s} /> : null}

          <main id="main">
            {!health.ok ? (
              <p className="card danger" role="alert">
                The API answered {health.status}: {health.error}
              </p>
            ) : null}
            {!screens.ok && !screens.down ? (
              <p className="card danger" role="alert" data-testid="screens-error">
                {screens.error}
              </p>
            ) : null}
            {!screens.ok && screens.down ? (
              <p className="card danger" role="alert" data-testid="api-down">
                {apiDownMessage()}
              </p>
            ) : null}
            {children}
          </main>

        </div>
      </div>
    </Shell>
  );
}

/** Brand, navigation and the standing note on what is simulated. Static apart from its children. */
function Rail({ groups, children, foot }: { groups: NavGroup[]; children?: React.ReactNode; foot?: React.ReactNode }) {
  return (
    <aside className="rail">
      <div>
        <Link href="/" className="brand" aria-label="Contra, start">
          <Mark />
          <span className="brand-name">Contra</span>
        </Link>
        <p className="brand-for">Back-charge credits for Ramp Bill Pay</p>
      </div>
      {children}
      <NavLinks groups={groups} />
      <div className="rail-foot">
        {foot}
        <p className="disclosure">A hackathon concept built for Ramp. It is not a Ramp product, and every Ramp screen here is simulated.</p>
      </div>
    </aside>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preload" href="/fonts/InstrumentSans.woff" as="font" type="font/woff" crossOrigin="anonymous" />
      </head>
      <body>
        <a className="skip" href="#main">
          Skip to the screen
        </a>
        <div className="app">{children}</div>
      </body>
    </html>
  );
}
