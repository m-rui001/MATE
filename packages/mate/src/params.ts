/**
 * Kernel parameters.
 *
 * The paper's central claim about parameters is "zero hardcoded behavioral thresholds": every
 * decision threshold is computed from personality and character. The constants here are
 * physiological rates (decay constants, coupling strengths), not behavioral cutoffs.
 */

import type { Drives, Emotion } from "./types.ts";

/** Per-emotion decay rate, 1/ms. Faster for surprise (orienting), slower for sadness. */
export const EMOTION_DECAY: Record<Emotion, number> = {
	joy: 1 / (45 * 60_000),
	trust: 1 / (180 * 60_000),
	fear: 1 / (25 * 60_000),
	surprise: 1 / (8 * 60_000),
	sadness: 1 / (150 * 60_000),
	disgust: 1 / (60 * 60_000),
	anger: 1 / (35 * 60_000),
	anticipation: 1 / (30 * 60_000),
};

/** Plutchik -> PAD projection. Rows: [pleasure, arousal, dominance] per unit intensity. */
export const EMOTION_PAD: Record<Emotion, [number, number, number]> = {
	joy: [0.9, 0.45, 0.35],
	trust: [0.55, -0.1, 0.2],
	fear: [-0.85, 0.8, -0.6],
	surprise: [0.05, 0.75, -0.25],
	sadness: [-0.8, -0.35, -0.45],
	disgust: [-0.75, 0.25, 0.15],
	anger: [-0.7, 0.75, 0.55],
	anticipation: [0.3, 0.45, 0.2],
};

/** Plutchik dyads: pairs that compose into a named complex emotion. */
export const DYADS: ReadonlyArray<{ name: string; a: Emotion; b: Emotion; min: number }> = [
	{ name: "love", a: "joy", b: "trust", min: 0.45 },
	{ name: "submission", a: "trust", b: "fear", min: 0.45 },
	{ name: "awe", a: "fear", b: "surprise", min: 0.45 },
	{ name: "disapproval", a: "surprise", b: "sadness", min: 0.45 },
	{ name: "remorse", a: "sadness", b: "disgust", min: 0.45 },
	{ name: "contempt", a: "disgust", b: "anger", min: 0.45 },
	{ name: "aggressiveness", a: "anger", b: "anticipation", min: 0.45 },
	{ name: "optimism", a: "anticipation", b: "joy", min: 0.45 },
];

/** Ornstein-Uhlenbeck mood parameters (Eq. 1 step 5). */
export const MOOD = {
	/** Pull toward the emotion-derived centre. */
	alpha: 1 / (6 * 60_000),
	/** Pull toward the personality default. */
	beta: 1 / (90 * 60_000),
	/** Stochastic term, per sqrt(ms). */
	sigma: 0.00004,
};

/** Opponent-process (Solomon & Corbit) coupling. */
export const OPPONENT = {
	/** B-process rise rate from the A-process. */
	ka: 0.35,
	/** B-process own decay, 1/ms. */
	kb: 1 / (75 * 60_000),
	/** How much of the B-process is subtracted from the net feeling. */
	gain: 0.6,
};

/** Drive dynamics, 1/ms. Connection accelerates when attachmentAnxiety > 0.4. */
export const DRIVE_RISE: Record<keyof Drives, number> = {
	connection: 1 / (5 * 3_600_000),
	curiosity: 1 / (9 * 3_600_000),
	expression: 1 / (3 * 3_600_000),
	growth: 1 / (24 * 3_600_000),
	rest: 1 / (12 * 3_600_000),
	// Under-stimulation builds fairly quickly — it is a low-level, restless itch.
	boredom: 1 / (4 * 3_600_000),
	// Existential tension is a slow background hum; the sharp changes come from sleep/wake events,
	// not from the passive dt rise, so this rate is deliberately low.
	selfPreservation: 1 / (72 * 3_600_000),
};

/** Drive saturation decay while satisfied, 1/ms. */
export const DRIVE_FALL = 1 / (40 * 60_000);

/** Awareness axis decay rates, 1/ms. */
export const AWARENESS_DECAY = {
	userPresence: 1 / (3 * 3_600_000),
	conversationWarmth: 1 / (2 * 3_600_000),
	socialPressure: 1 / (8 * 3_600_000),
	thoughtSaturation: 1 / (6 * 3_600_000),
};

/** Lindblad dephasing rate for the density matrix off-diagonals, 1/ms. */
export const DECOHERENCE = 1 / (20 * 60_000);

/** Hamiltonian diagonal energies per emotion (arbitrary units, relative). */
export const HAMILTONIAN: Record<Emotion, number> = {
	joy: 0.9,
	trust: 0.6,
	fear: -0.7,
	surprise: 0.3,
	sadness: -0.6,
	disgust: -0.4,
	anger: -0.5,
	anticipation: 0.4,
};

/**
 * Off-diagonal coupling of the emotional Hamiltonian (MATE section 3.1, "relationship-modulated
 * coupling").
 *
 * A DIAGONAL Hamiltonian can never produce an order effect: diagonal unitaries are phase rotations
 * and phases add commutatively, so U_A U_B = U_B U_A exactly. The paper's headline result - warmth
 * then hostility != hostility then warmth, ||dPAD|| = 0.48, classical gives 0 - REQUIRES off-diagonal
 * coupling so that [H_A, H_B] != 0. The coupling is laid out on Plutchik's wheel: adjacent emotions
 * couple positively, opposite emotions negatively, via K_ij = cos(2*pi*(i-j)/8). WHEEL_COUPLING is
 * the base strength g0; the effective g is scaled up by relationship trust (a trusted bond entangles
 * emotions more strongly, so ambivalence persists longer - the paper's decoherence/coupling story).
 */
export const WHEEL_COUPLING = 0.4;

/** How strongly triggered intensity raises an emotion's own diagonal energy. */
export const HAMILTONIAN_INTENSITY = 1.6;

/**
 * Base unitary rotation angle per emotional event, radians.
 *
 * This is the CRITICAL difference from a dt-scaled phase: the kick is a fixed rotation applied once
 * per emotional event (scaled by its intensity), NOT proportional to the time since the last one.
 * That is what makes the order effect appear even for two near-simultaneous messages - it is a
 * property of the SEQUENCE of rotations, not of elapsed time. pi/3 gives Rabi-like population
 * transfer large enough to read on PAD without scrambling the state.
 */
export const KICK_ANGLE = Math.PI / 3;

/** Character micro-nudge bound per message (paper: 0.001-0.005). */
export const NUDGE_MAX = 0.005;

/** Effort model coefficients (Eq. 2). */
export const EFFORT_W = {
	arousal: 0.4,
	comfort: -0.35,
	conscientiousness: 0.12,
	extraversion: 0.08,
	reflectiveness: 0.06,
	selfEfficacy: 0.04,
	bias: 0.28,
	noise: 0.06,
};

/** Token ceilings per effort band. Kept tight: this is the main cost lever. */
export const TOKEN_CEILING: Record<string, number> = {
	autopilot: 40,
	brief: 220,
	normal: 700,
	engaged: 2000,
};

/** Intent scaling on the ceiling. */
export const INTENT_SCALE: Record<string, number> = {
	chat: 0.6,
	question: 1.0,
	task: 1.6,
};

/** Communication energy weights (Eq. 12). */
export const ENERGY_W = { arousal: 0.5, extraversion: 0.2, pleasure: 0.15, attachment: 0.15, depth: 0.08 };

/** Send-style burst weights (Eq. 14). */
export const BURST_W = { extraversion: 0.3, reflectiveness: 0.25, arousal: 0.2, trust: 0.15, directness: 0.1 };

/** Meta-emotion depth damping: I_d = 0.3^d. */
export const META_EMOTION_DAMPING = 0.3;

/** Sleep window, local hours [start, end). Consolidation runs once per crossed window. */
export const SLEEP_WINDOW: [number, number] = [1, 5];

/** Heartbeat interval, ms. Live loop only; offline catch-up ignores it entirely. */
export const HEARTBEAT_MS = 60_000;

/** Maximum subjective-time warp factors (Eq. 13). */
export const TEMPORAL_WARP = { anxiety: 1.5, tolerance: 0.4, pleasure: 0.3, neuroticism: 0.5 };

/** Bound on trust drop per single event, as a fraction of current trust. */
export const TRUST_DROP_CAP = 0.12;

/** Cusp catastrophe thresholds. */
export const CUSP = { dominanceMax: -0.35, arousalMin: 0.6 };

/** Self-observation ring buffer size. Older observations are consolidated, not kept verbatim. */
export const MAX_OBSERVATIONS = 64;

/** Habituation effective time constant, ms (Eq. 15 region). */
export const HABITUATION_TAU = 4 * 3_600_000;
