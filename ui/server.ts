import "server-only";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { App } from "../src/app.ts";

const DB = "data/demo.db";
const SRC = "data/extraction-source.txt";
const g = globalThis as unknown as { __contraApp?: App };

/** One App per server process, kept on globalThis so dev reloads don't open the database twice. */
export function getApp(): App {
  if (!g.__contraApp) {
    mkdirSync("data", { recursive: true });
    g.__contraApp = new App(DB);
  }
  return g.__contraApp;
}

export function resetApp(): App {
  g.__contraApp?.close();
  g.__contraApp = undefined;
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`, SRC]) if (existsSync(f)) rmSync(f);
  return getApp();
}

/** Persisted beside the database so a server restart keeps the on-screen disclosure honest. */
export const usedSampleExtractions = () => existsSync(SRC) && readFileSync(SRC, "utf8") === "sample";
export const setExtractionSource = (kind: "sample" | "recorded") => {
  mkdirSync("data", { recursive: true });
  writeFileSync(SRC, kind);
};
