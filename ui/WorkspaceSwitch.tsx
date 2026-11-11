"use client";
import { useTransition } from "react";
import { chooseWorkspace } from "./actions.ts";

/** "Scripted demo" or "Live inbox" (?workspace=live on every API call). */
export function WorkspaceSwitch({ current, liveAvailable }: { current: "demo" | "live"; liveAvailable: boolean }) {
  const [pending, start] = useTransition();
  const pick = (ws: "demo" | "live") => start(() => chooseWorkspace(ws));
  return (
    <span className="switch" role="group" aria-label="Workspace">
      <button type="button" className={current === "demo" ? "seg on" : "seg"} aria-pressed={current === "demo"} disabled={pending} onClick={() => pick("demo")} data-testid="workspace-demo">
        Scripted demo
      </button>
      <button
        type="button"
        className={current === "live" ? "seg on" : "seg"}
        aria-pressed={current === "live"}
        disabled={pending || (!liveAvailable && current !== "live")}
        title={liveAvailable ? undefined : "This API has no live workspace (start it with CONTRA_INBOX=gmail)"}
        onClick={() => pick("live")}
        data-testid="workspace-live"
      >
        Live inbox
      </button>
    </span>
  );
}
