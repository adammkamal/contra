"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Subscribes to GET /api/events (Server-Sent Events) and re-fetches the screens when the workspace on
 * screen changed. No polling: EventSource keeps one connection open and, if the API restarts, reconnects
 * on its own (the API asks for a 3 s retry); after a reconnect the screens are re-fetched once.
 */
export function LiveUpdates({ base, workspace }: { base: string; workspace: "demo" | "live" }) {
  const router = useRouter();
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    const es = new EventSource(`${base}/api/events`);
    let lost = false;
    es.onopen = () => {
      setConnected(true);
      if (lost) router.refresh();
      lost = false;
    };
    es.onerror = () => {
      lost = true;
      setConnected(false);
    };
    es.addEventListener("screens-changed", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent<string>).data) as { workspace?: string };
        if (data.workspace === workspace) router.refresh();
      } catch {
        /* not ours */
      }
    });
    return () => es.close();
  }, [base, workspace, router]);
  return (
    <span className="live-dot" data-testid="live-updates" data-connected={connected === true ? "yes" : "no"}>
      {connected === false ? "Updates paused (reconnecting)" : connected ? "Live updates on" : "Connecting"}
    </span>
  );
}
