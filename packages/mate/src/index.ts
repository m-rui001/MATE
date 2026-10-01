/**
 * MATE - a deterministic affective kernel for pi-based companions.
 *
 * Port and adaptation of Lobozov, S. "MATE: A Deterministic Affective Middleware for LLM-Based
 * Companions with Emergent Character and Persistent Internal State" v8 (Zenodo 20400530,
 * CC-BY-4.0), extended for a machine that powers off (see catchup.ts) and with an encrypted
 * sealed self (see secret.ts).
 *
 * Public surface, grouped by role:
 *   - state:   birth, sanitiseState, MateState and friends
 *   - kernel:  transition (the pure function), sleepTransition, effort/energy/burst models
 *   - offline: catchUp, verifySubdivisionInvariance, crossedSleepWindows
 *   - context: stateContext / minimalContext (the ~53-token projection)
 *   - autonomy: tick, shouldReply, generateThoughts, preSendReview, sendStyle
 *   - secrets: loadKey, seal/unseal, publicView, sealedHints
 *   - quantum: the density-matrix helpers, exposed for tests and introspection
 *   - store:   load/save with atomic writes
 */

export * from "./types.ts";
export * from "./params.ts";
export * from "./rng.ts";
export * from "./quantum.ts";
export * from "./birth.ts";
export * from "./kernel.ts";
export * from "./catchup.ts";
export * from "./context.ts";
export * from "./daemon.ts";
export * from "./secret.ts";
export * from "./store.ts";
