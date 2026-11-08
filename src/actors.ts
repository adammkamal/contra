import type { Actor } from "./types.ts";

/** Demo identities. Production replaces these with signed-in users and roles. */
export const PM: Actor = { kind: "human", id: "dana.ortiz", role: "pm" };
export const CONTROLLER: Actor = { kind: "human", id: "lee.chen", role: "controller" };
export const AP: Actor = { kind: "human", id: "sam.ap", role: "ap" };
export const RECORDED_EXTRACTOR: Actor = { kind: "llm", id: "extractor", model: "recorded" };
