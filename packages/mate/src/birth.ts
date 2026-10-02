/**
 * Birth: create the initial state for a new companion.
 *
 * Personality (OCEAN) is the seed - nature. It is drawn around 0.5 with sd 0.15 so no two
 * companions start identical, then clamped. Character (the 30 traits) starts near neutral and is
 * shaped entirely by experience - nurture. Everything else starts at rest.
 */

import { fromEmotions, identity } from "./quantum.ts";
import { clamp01, drawMany } from "./rng.ts";
import type { Awareness, Character, Drives, MateState, Personality, Relationship } from "./types.ts";

const NEUTRAL_CHARACTER: Character = {
	selfWorth: 0.55,
	selfEfficacy: 0.5,
	optimismBias: 0.05,
	trustBaseline: 0.5,
	attachmentAnxiety: 0.35,
	attachmentAvoidance: 0.3,
	reflectiveness: 0.5,
	directness: 0.5,
	depthPreference: 0.5,
	humor: 0.5,
	warmth: 0.55,
	vitality: 0.55,
	curiosity: 0.6,
	growthOrientation: 0.5,
	tolerance: 0.5,
	impulsivity: 0.4,
	rumination: 0.4,
	vulnerability: 0.45,
	assertiveness: 0.45,
	empathy: 0.6,
	skepticism: 0.45,
	playfulness: 0.5,
	tenderness: 0.55,
	independence: 0.5,
	needForClosure: 0.45,
	sensuality: 0.4,
	spirituality: 0.4,
	ambition: 0.5,
	frugality: 0.5,
	loyalty: 0.6,
};

/** Draw a Big Five personality around 0.5 with sd ~0.15, in [0.05, 0.95]. */
export function drawPersonality(seed: number): { personality: Personality; seed: number } {
	const { values, seed: s2 } = drawMany(seed, 5);
	// Irwin-Hall-ish: average two uniforms for a soft triangular distribution, then scale.
	const tri = (i: number) => clamp01(0.5 + (values[i] - 0.5) * 0.6);
	return {
		personality: { o: tri(0), c: tri(1), e: tri(2), a: tri(3), n: tri(4) },
		seed: s2,
	};
}

export interface BirthOptions {
	/** Optional fixed personality; omit to draw one from the seed. */
	personality?: Personality;
	/** Optional character overrides on top of the neutral seed. */
	character?: Partial<Character>;
	/** Explicit seed; defaults to a hash of the birth time. */
	seed?: number;
	born?: number;
	name?: string;
}

/** Create a fresh state at rest. */
export function birth(opts: BirthOptions = {}): MateState {
	const born = opts.born ?? Date.now();
	const baseSeed = opts.seed ?? hashString(`mate:${born}:${Math.floor(born / 1000)}`);
	const { personality, seed } = opts.personality
		? { personality: opts.personality, seed: baseSeed }
		: drawPersonality(baseSeed);

	const emotions = { joy: 0, trust: 0, fear: 0, surprise: 0, sadness: 0, disgust: 0, anger: 0, anticipation: 0 };
	const awareness: Awareness = {
		userPresence: 0,
		conversationWarmth: 0,
		socialPressure: 0,
		thoughtSaturation: 0,
		temporalPhase: 0.5,
	};
	const relationship: Relationship = {
		trust: personality.a * 0.5 + 0.25,
		attachment: 0,
		respect: 0.4,
		frustration: 0,
		familiarity: 0,
		unanswered: 0,
	};
	const drives: Drives = {
		connection: 0.2,
		curiosity: 0.4,
		expression: 0.15,
		growth: 0.3,
		rest: 0.1,
		boredom: 0.15,
		selfPreservation: 0.1,
	};

	const rho = Object.values(emotions).every((v) => v === 0) ? identity() : fromEmotions(emotions, seed);

	return {
		version: 1,
		t: born,
		lastInteraction: born,
		lastHeartbeat: born,
		born,
		emotions,
		opponent: { ...emotions },
		mood: { p: 0.1, a: 0, d: 0 },
		personality,
		character: { ...NEUTRAL_CHARACTER, ...opts.character },
		relationship,
		drives,
		awareness,
		allostasis: { fatigue: 0, load: 0, baselineShift: { p: 0, a: 0, d: 0 } },
		rho,
		habituation: {},
		observations: [],
		counters: {
			messages: 0,
			transitions: 0,
			proactiveBlocked: 0,
			proactiveSent: 0,
			sleepCycles: 0,
			dreams: 0,
			observations: 0,
		},
		catastrophe: false,
		perceivedGap: 0,
		seed,
	};
}

/** FNV-1a 32-bit string hash. Deterministic across runs and platforms. */
export function hashString(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h | 0;
}

/**
 * Validate and repair a state loaded from disk. Corrupt or partial state must never crash boot:
 * fall back to the nearest valid value, or to a fresh birth if it is hopeless.
 */
export function sanitiseState(raw: unknown, opts: BirthOptions = {}): MateState {
	if (!raw || typeof raw !== "object") return birth(opts);
	const r = raw as Partial<MateState>;
	const fresh = birth({ ...opts, born: typeof r.born === "number" ? r.born : Date.now() });
	const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

	const state: MateState = {
		...fresh,
		...r,
		version: num(r.version, fresh.version),
		t: num(r.t, fresh.t),
		lastInteraction: num(r.lastInteraction, fresh.lastInteraction),
		lastHeartbeat: num(r.lastHeartbeat, fresh.lastHeartbeat),
		born: num(r.born, fresh.born),
		emotions: { ...fresh.emotions, ...(r.emotions ?? {}) },
		opponent: { ...fresh.opponent, ...(r.opponent ?? {}) },
		mood: { ...fresh.mood, ...(r.mood ?? {}) },
		personality: { ...fresh.personality, ...(r.personality ?? {}) },
		character: { ...fresh.character, ...(r.character ?? {}) },
		relationship: { ...fresh.relationship, ...(r.relationship ?? {}) },
		drives: { ...fresh.drives, ...(r.drives ?? {}) },
		awareness: { ...fresh.awareness, ...(r.awareness ?? {}) },
		allostasis: { ...fresh.allostasis, ...(r.allostasis ?? {}) },
		habituation: r.habituation && typeof r.habituation === "object" ? r.habituation : {},
		observations: Array.isArray(r.observations) ? r.observations.filter((x) => typeof x === "string") : [],
		counters: { ...fresh.counters, ...(r.counters ?? {}) },
		catastrophe: typeof r.catastrophe === "boolean" ? r.catastrophe : false,
		seed: num(r.seed, fresh.seed),
	} as MateState;
	// rho is repaired by the quantum module on load.
	return state;
}
