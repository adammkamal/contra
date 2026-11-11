"use client";
import { useTransition } from "react";
import { chooseWorkspace } from "./actions.ts";

/**
 * "Scripted demo" or "Live inbox" (?workspace=live on every API call). When this account can't open the live
 * workspace, its half is disabled and `liveRefusal` (the API's own words) says why.
 */
export function WorkspaceSwitch({ current, liveRefusal }: { current: "demo" | "live"; liveRefusal: string | null }) {
  const [pending, start] = useTransition();
  const pick = (ws: "demo" | "live") => start(() => chooseWorkspace(ws));
  return (
    <div className="switch-wrap">
      <span className="switch" role="group" aria-label="Workspace">
        <button type="button" className={current === "demo" ? "seg on" : "seg"} aria-pressed={current === "demo"} disabled={pending} onClick={() => pick("demo")} data-testid="workspace-demo">
          Scripted demo
        </button>
        <button
          type="button"
          className={current === "live" ? "seg on" : "seg"}
          aria-pressed={current === "live"}
          disabled={pending || liveRefusal !== null}
          title={liveRefusal ?? undefined}
          aria-describedby={liveRefusal ? "live-refusal" : undefined}
          onClick={() => pick("live")}
          data-testid="workspace-live"
        >
          Live inbox
        </button>
      </span>
      {liveRefusal ? (
        <p className="switch-note" id="live-refusal" data-testid="workspace-live-refusal">
          Live inbox: {liveRefusal}
        </p>
      ) : null}
    </div>
  );
}
