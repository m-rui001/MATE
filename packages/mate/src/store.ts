/**
 * Persistence.
 *
 * The state must survive a power-off, because the whole catch-up design is about waking from one.
 * Writes are atomic (temp file + rename) so a crash mid-write cannot corrupt the companion: a
 * torn JSON file is the one thing that would silently reset someone's inner life.
 *
 * Layout, under a state dir (default ~/.mate):
 *   state.json    the affective state
 *   memory.json   the associative memory graph (see memory.ts)
 *   sessions.json the open/close autobiographical log (see session.ts)
 *   lang.json     the prompt language the user picked (see loadLang)
 *
 * Older state directories may still contain a sealed.json and a .sealed-key file from a previous
 * version; they are simply ignored and never cleaned up.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitiseState } from "./birth.ts";
import { type Lang, normLang } from "./i18n.ts";
import { type MemoryGraph, sanitiseMemory } from "./memory.ts";
import { sanitise as sanitiseRho } from "./quantum.ts";
import { type SessionLog, sanitiseSessions } from "./session.ts";
import type { MateState } from "./types.ts";

export interface StoreOptions {
	dir: string;
	/** Human name for this companion, used in prompts and the birth seed. */
	name?: string;
}

export interface Persisted {
	state: MateState;
	memory: MemoryGraph;
	sessions: SessionLog;
	dir: string;
}

const STATE_FILE = "state.json";
const MEMORY_FILE = "memory.json";
const SESSIONS_FILE = "sessions.json";
const LANG_FILE = "lang.json";

/**
 * The companion's prompt language, persisted next to the state (NOT inside it).
 *
 * It deliberately lives outside MateState: the state is the kernel's, replayed and duplicated by
 * tests, and language is a HOST choice about how the kernel renders itself. Keeping it in its own
 * small file also means choosing a language never invalidates a boot catch-up. Returns null when
 * the user has never chosen, which is what the first-run picker
 * keys off (null means "ask", "en" means "already chose English"). Never throws.
 */
export function loadLang(dir: string): Lang | null {
	const raw = readJson<{ lang?: unknown }>(join(dir, LANG_FILE));
	if (!raw || typeof raw.lang !== "string") return null;
	return normLang(raw.lang);
}

export function saveLang(dir: string, lang: Lang): void {
	writeJsonAtomic(join(dir, LANG_FILE), { version: 1, lang });
}

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

	const rawState = readJson<unknown>(join(dir, STATE_FILE));
	let state = sanitiseState(rawState, { name: opts.name });
	// The density matrix has its own repair path (Hermiticity, Tr=1, positivity).
	state = { ...state, rho: sanitiseRho(state.rho) };

	// The graph repairs itself on load: a corrupt memory.json is a lost memory, not a crashed boot.
	const memory = sanitiseMemory(readJson<unknown>(join(dir, MEMORY_FILE)));

	// Same for the session log — a corrupt open/close history is forgotten, never fatal.
	const sessions = sanitiseSessions(readJson<unknown>(join(dir, SESSIONS_FILE)));

	return { state, memory, sessions, dir };
}

/** Persist state + memory + sessions atomically. Cheap enough to call after every transition. */
export function save(p: Persisted): void {
	writeJsonAtomic(join(p.dir, STATE_FILE), p.state);
	writeJsonAtomic(join(p.dir, MEMORY_FILE), p.memory);
	writeJsonAtomic(join(p.dir, SESSIONS_FILE), p.sessions);
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
