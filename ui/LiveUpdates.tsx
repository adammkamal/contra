"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Subscribes to the API's Server-Sent Events through the UI's own /api/events (app/api/events/route.ts, which
 * forwards the session) and re-fetches the screens when the workspace on screen changed. No polling: if the
 * API restarts, EventSource reconnects on its own and the screens are re-fetched once. When the session has
 * ended, the stream is closed and the sign-in page opens, returning here afterwards.
 */
export function LiveUpdates({ workspace }: { workspace: "demo" | "live" }) {
  const router = useRouter();
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    const es = new EventSource("/api/events");
    let lost = false;
    es.addEventListener("connected", () => {
      setConnected(true);
      if (lost) router.refresh();
      lost = false;
    });
    const drop = () => {
      lost = true;
      setConnected(false);
    };
    es.addEventListener("api-down", drop);
    es.onerror = drop;
    es.addEventListener("signed-out", () => {
      es.close();
      const here = window.location.pathname + window.location.search;
      window.location.assign(`/login?ended=1&next=${encodeURIComponent(here)}`);
    });
    es.addEventListener("screens-changed", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent<string>).data) as { workspace?: string };
        if (data.workspace === workspace) router.refresh();
      } catch {
        /* not ours */
      }
    });
    return () => es.close();
  }, [workspace, router]);
  return (
    <span className="live-dot" data-testid="live-updates" data-connected={connected === true ? "yes" : "no"}>
      {connected === false ? "Updates paused (reconnecting)" : connected ? "Live updates on" : "Connecting"}
    </span>
  );
}
