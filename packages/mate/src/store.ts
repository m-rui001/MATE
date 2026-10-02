/**
 * Persistence.
 *
 * The state must survive a power-off, because the whole catch-up design is about waking from one.
 * Writes are atomic (temp file + rename) so a crash mid-write cannot corrupt the companion: a
 * torn JSON file is the one thing that would silently reset someone's inner life.
 *
 * Layout, under a state dir (default ~/.mate):
 *   state.json    the affective state (public + private tiers)
 *   sealed.json   the encrypted sealed tier
 *   .sealed-key   the birth key, 0600, never leaves this machine
 *   memory/       optional long-term graph shards (see memory.ts)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitiseState } from "./birth.ts";
import { sanitise as sanitiseRho } from "./quantum.ts";
import { emptySealed, loadKey, type SealedStore } from "./secret.ts";
import type { MateState } from "./types.ts";

export interface StoreOptions {
	dir: string;
	/** Human name for this companion, used in prompts and the birth seed. */
	name?: string;
}

export interface Persisted {
	state: MateState;
	sealed: SealedStore;
	key: Buffer;
	dir: string;
	/** True when this state directory was born on a different machine: the sealed tier is inert
	 * (the key cannot be re-derived), so the companion wakes without access to its private self. */
	foreign: boolean;
}

const STATE_FILE = "state.json";
const SEALED_FILE = "sealed.json";

/** Atomic JSON write: write to a temp sibling, then rename over the target. */
export function writeJsonAtomic(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 1));
	renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

/**
 * Load (or birth) the persisted companion. Never throws: a corrupt state falls back to a repaired
 * or freshly born one, so the companion always boots.
 */
export function load(opts: StoreOptions): Persisted {
	const dir = opts.dir;
	mkdirSync(dir, { recursive: true });
	const { key, foreign } = loadKey(dir);

	const rawState = readJson<unknown>(join(dir, STATE_FILE));
	let state = sanitiseState(rawState, { name: opts.name });
	// The density matrix has its own repair path (Hermiticity, Tr=1, positivity).
	state = { ...state, rho: sanitiseRho(state.rho) };

	const rawSealed = readJson<SealedStore>(join(dir, SEALED_FILE));
	const sealed = rawSealed && typeof rawSealed === "object" && Array.isArray(rawSealed.entries) ? rawSealed : emptySealed();

	return { state, sealed, key, dir, foreign };
}

/** Persist state + sealed atomically. Cheap enough to call after every transition. */
export function save(p: Persisted): void {
	writeJsonAtomic(join(p.dir, STATE_FILE), p.state);
	writeJsonAtomic(join(p.dir, SEALED_FILE), p.sealed);
}

/** How long since the last write - drives whether catch-up is needed on boot. */
export function lastWriteAge(dir: string): number {
	const f = join(dir, STATE_FILE);
	if (!existsSync(f)) return Number.POSITIVE_INFINITY;
	try {
		return Date.now() - statSync(f).mtimeMs;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}
