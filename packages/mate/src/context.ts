/**
 * Context assembly (MATE step 5): the compact state vector that goes into the LLM prompt.
 *
 * The paper's budget is ~53 tokens. That is a hard target here, not an aspiration: this XML is
 * prepended to EVERY turn, so every token in it is paid for on every single message forever. A
 * naive dump of MateState is ~2,000 tokens; the projection below is ~50, a 40x reduction on the
 * one part of the prompt that can never be cached away.
 *
 * Three rules keep it small and keep it honest:
 *   1. Quantise. Emotions and drives are emitted only if above a floor, rounded to 2 decimals,
 *      and sorted by magnitude so the top few carry the signal. Zero-valued channels cost nothing.
 *   2. Name, don't number. The LLM does better with "sad.4 trust.6" than "sadness=0.42".
 *   3. Layer visibility. This is what the LLM sees to BE the character. It is NOT what the user is
 *      shown. The sealed parts (see secret.ts) never enter this projection at all.
 */

import { energyOf, burstOf, perceivedDuration, temporalMood, noticeThreshold } from "./kernel.ts";
import { totalCoherence, diagonalEntropy } from "./quantum.ts";
import { EMOTIONS, type MateState, type PAD } from "./types.ts";

export interface ContextOptions {
	/** Local wall clock for the turn, epoch ms. */
	now?: number;
	/** Timezone label, e.g. "Asia/Shanghai". */
	tz?: string;
	/** Include the catch-up gap note (set after a powered-off boot). */
	gapLabel?: string;
	/** Max characters for the whole block; the projector trims lowest-signal channels first. */
	maxChars?: number;
}

/** Round to 2 decimals and drop trailing zero, e.g. 0.40 -> ".4". */
function q(x: number): string {
	const r = Math.round(x * 100) / 100;
	return r.toFixed(2).replace(/^0/, "").replace(/0$/, "").replace(/\.$/, "") || "0";
}

/** Format PAD compactly. */
function pad(pad: PAD): string {
	return `${q(pad.p)},${q(pad.a)},${q(pad.d)}`;
}

/** Top-N non-trivial channels, as "name.value" tokens sorted by magnitude. */
function topChannels(values: Record<string, number> | object, floor = 0.12, n = 4): string {
	const entries = Object.entries(values as Record<string, number>)
		.filter(([, v]) => typeof v === "number" && v >= floor)
		.sort((a, b) => b[1] - a[1])
		.slice(0, n)
		.map(([k, v]) => `${k}${q(v)}`);
	return entries.join(" ");
}

/** One-word mood gloss, so the LLM has a handle it can speak to without doing arithmetic. */
function moodWord(m: PAD): string {
	const { p, a } = m;
	if (p > 0.4 && a > 0.3) return "buoyant";
	if (p > 0.4) return "warm";
	if (p > 0.1) return "settled";
	if (p > -0.2 && a > 0.4) return "wired";
	if (p > -0.2) return "flat";
	if (a > 0.4) return "agitated";
	if (a < -0.2) return "low";
	return "heavy";
}

/**
 * The projection. Kept deliberately terse: this is felt, not narrated. The LLM turns it into
 * behaviour; it is never meant to be read aloud verbatim.
 */
export function stateContext(state: MateState, opts: ContextOptions = {}): string {
	const now = opts.now ?? state.t;
	const gap = now - state.lastInteraction;
	const perceived = perceivedDuration(state, gap);
	const temporal = temporalMood(perceived);
	const tz = opts.tz;
	const clock = new Date(now);
	const hhmm = `${String(clock.getHours()).padStart(2, "0")}:${String(clock.getMinutes()).padStart(2, "0")}`;
	const energy = energyOf(state);
	const burst = burstOf(state);

	const emo = topChannels(state.emotions, 0.12, 4);
	const drives = topChannels(state.drives, 0.25, 4);
	const coherence = totalCoherence(state.rho);
	const entropy = diagonalEntropy(state.rho);

	const lines: string[] = [];
	// Time metadata: the user explicitly wants the companion to see time. Kept to one line.
	const timeBits = [`now ${hhmm}`];
	if (tz) timeBits.push(tz);
	timeBits.push(`silent ${fmtDur(gap)} (feels ${temporal})`);
	if (opts.gapLabel) timeBits.push(`woke after ${opts.gapLabel} off`);
	lines.push(`time: ${timeBits.join(", ")}`);

	lines.push(`mood: ${moodWord(state.mood)} pad ${pad(state.mood)}${emo ? ` | ${emo}` : ""}`);
	if (drives) lines.push(`drives: ${drives}`);

	// Relationship + self, one line each, only the channels that matter right now.
	const rel = state.relationship;
	lines.push(`us: trust ${q(rel.trust)} close ${q(rel.attachment)}${rel.unanswered ? ` ignored x${rel.unanswered}` : ""}`);
	const ch = state.character;
	lines.push(
		`self: worth ${q(ch.selfWorth)} ease ${q(ch.selfEfficacy)} anxious ${q(ch.attachmentAnxiety)} tired ${q(state.allostasis.fatigue)}`,
	);

	// Energy governs verbosity; burst governs whether to split into several short messages.
	lines.push(`impulse: energy ${q(energy)} burst ${q(burst)} | coherence ${q(coherence)} entropy ${q(entropy)}`);

	// The single most recent self-observation, if any: continuity of inner life across turns.
	const lastObs = state.observations[state.observations.length - 1];
	if (lastObs) lines.push(`last thought: ${truncate(lastObs, 90)}`);

	const body = `<mate>\n${lines.join("\n")}\n</mate>`;
	const max = opts.maxChars ?? 1400;
	return body.length <= max ? body : `${body.slice(0, max - 12)}\n…\n</mate>`;
}

/**
 * A smaller projection meant for background/autonomous runs where we still want affect but every
 * token counts even more. Roughly half the size of stateContext.
 */
export function minimalContext(state: MateState, opts: ContextOptions = {}): string {
	const now = opts.now ?? state.t;
	const temporal = temporalMood(perceivedDuration(state, now - state.lastInteraction));
	const emo = topChannels(state.emotions, 0.15, 3);
	const drives = topChannels(state.drives, 0.3, 3);
	const lines = [
		`${moodWord(state.mood)} pad ${pad(state.mood)}${emo ? ` ${emo}` : ""}`,
		drives ? `drives ${drives}` : "",
		`silent ${temporal}, energy ${q(energyOf(state))}`,
	].filter(Boolean);
	return `<mate>${lines.join(" | ")}</mate>`;
}

/** Notice threshold for drive-delta self-observations, exposed for the daemon. */
export function driveNoticeThreshold(state: MateState): number {
	return noticeThreshold(state.personality.n);
}

function fmtDur(ms: number): string {
	const m = Math.round(ms / 60_000);
	if (m < 1) return "<1m";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** Emotion channels, exported for the daemon's thinking loop. */
export { EMOTIONS };
