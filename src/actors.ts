import type { Actor, Human } from "./types.ts";

/** Demo identities. Production replaces these with signed-in users and roles. */
export const PM: Human = { kind: "human", id: "dana.ortiz", role: "pm" };
export const CONTROLLER: Human = { kind: "human", id: "lee.chen", role: "controller" };
export const AP: Human = { kind: "human", id: "sam.ap", role: "ap" };
/**
 * Hand-written sample extractions (src/seed.ts). Deliberately NOT an llm actor: the audit log and the
 * screens must never credit hand-written data to the model.
 */
export const SAMPLE_EXTRACTIONS: Actor = { kind: "system", id: "sample-extractions" };
