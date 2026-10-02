/**
 * Context assembly (MATE step 5): what the LLM is shown of its own inner life.
 *
 * There are TWO surfaces, split on purpose (P5 — prompt caching; P2 — the old single 73-token
 * projection was an information bottleneck that starved the mind):
 *
 *   - `stableContext`: identity, personality, core character, and the memory-graph summary. This
 *     changes slowly (personality is fixed per message and drifts weekly; character is nurture, not
 *     mood; the graph summary is top-by-strength so it edits rarely), so it rides a CACHED system
 *     prompt section and is paid for once, not per turn.
 *
 *   - `stateContext`: the VOLATILE per-turn delta — the clock, mood, emotions, drives, relationship,
 *     impulse, the reply inclination, and the specific memories this message recalls. Small and
 *     always-fresh, so it rides the ephemeral `context` tail and never bloats the cache.
 *
 * Because the heavy stuff is now cached, the volatile tail is FREE to be richer than the old
 * ~73-token budget: it can actually describe the state (P2) without every token being re-paid on
 * every message forever. Quantise + name-don't-number still apply — the block is felt, not narrated.
 * The sealed parts (secret.ts) never enter either projection; only a count is surfaced.
 */

import type { ReplyInclination } from "./daemon.ts";
import { burstOf, energyOf, noticeThreshold, perceivedDuration, temporalMood } from "./kernel.ts";
import { type MemoryGraph, summary as memorySummary, type RecallHit } from "./memory.ts";
import { diagonalEntropy, totalCoherence } from "./quantum.ts";
import { EMOTIONS, type MateState, type PAD } from "./types.ts";

export interface ContextOptions {
	/** Local wall clock for the turn, epoch ms. */
	now?: number;
	/** Timezone label, e.g. "Asia/Shanghai". */
	tz?: string;
	/** Include the catch-up gap note (set after a powered-off boot). */
	gapLabel?: string;
	/** Advisory reply inclination for THIS inbound message (P1: a signal to the model, not a gate). */
	inclination?: ReplyInclination;
	/** Specific memories this message recalls (P4), surfaced in the volatile tail. */
	recall?: RecallHit[];
	/** A one-line open/close summary for THIS body (see session.ts): when it woke, how often today. */
	session?: string;
	/** Max characters for the whole block; the projector trims lowest-signal channels first. */
	maxChars?: number;
}

/** Options for the stable, cacheable prefix. */
export interface StableContextOptions {
	/** Display name. The kernel does not store the name (a host concern), so it is passed in. */
	name?: string;
	/** The memory graph to summarise; omit for a no-graph companion. */
	memory?: MemoryGraph;
	/** Cap on graph nodes/edges in the summary. */
	memoryNodes?: number;
	memoryEdges?: number;
	/** Max characters for the whole block. */
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

/** Core character traits, rendered as name.value with a floor so only meaningful ones show. */
function topTraits(ch: MateState["character"], floor = 0.55, n = 8): string {
	const entries = Object.entries(ch)
		.filter(([k, v]) => k !== "optimismBias" && typeof v === "number" && (v >= floor || v <= 1 - floor))
		.sort((a, b) => Math.abs(b[1] - 0.5) - Math.abs(a[1] - 0.5))
		.slice(0, n)
		.map(([k, v]) => `${k} ${q(v)}`);
	return entries.join(", ");
}

/**
 * The STABLE, cacheable prefix: who I am (identity + personality + core character) plus the slow
 * memory-graph summary. Emits ONLY content that changes on the timescale of days, so prompt caching
 * holds across long stretches of conversation (P5). The volatile per-turn delta is NOT here; that
 * rides `stateContext`.
 */
export function stableContext(state: MateState, opts: StableContextOptions = {}): string {
	const p = state.personality;
	const lines: string[] = [];

	// Identity: name + how long this self has existed (continuity of being).
	const days = Math.max(0, Math.floor((state.t - state.born) / 86_400_000));
	lines.push(`name: ${opts.name ?? "mate"} · ${days}d old · ${state.counters.messages} messages lived`);

	// Personality (Big Five): fixed per message, drifts only weekly → cacheable.
	lines.push(`nature: O${q(p.o)} C${q(p.c)} E${q(p.e)} A${q(p.a)} N${q(p.n)}`);

	// Character (SOUL): the nurture layer, only the pronounced traits.
	const traits = topTraits(state.character);
	if (traits) lines.push(`character: ${traits}`);

	// Baseline disposition: the slow PAD set-point the mood oscillates around.
	const b = state.allostasis.baselineShift;
	lines.push(`baseline: ${q(b.p)},${q(b.a)},${q(b.d)}`);

	// Memory-graph summary: top concepts by strength + strongest ties. Changes slowly.
	if (opts.memory) {
		const summary = memorySummary(opts.memory, { nodes: opts.memoryNodes ?? 12, edges: opts.memoryEdges ?? 10 });
		if (summary) lines.push(summary);
	}

	const body = `<mate-core>\n${lines.join("\n")}\n</mate-core>`;
	const max = opts.maxChars ?? 2400;
	return body.length <= max ? body : `${body.slice(0, max - 16)}\n…\n</mate-core>`;
}

/**
 * The VOLATILE per-turn delta. Richer than the old ~73-token budget now that the heavy content is
 * cached (P2): the mind can actually see its own state each turn. Still quantised and terse, because
 * this rides every LLM call in a run — it is felt, not narrated. The model turns it into behaviour;
 * it is never read back verbatim.
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

	const emo = topChannels(state.emotions, 0.1, 5);
	const drives = topChannels(state.drives, 0.2, 7);
	const coherence = totalCoherence(state.rho);
	const entropy = diagonalEntropy(state.rho);

	const lines: string[] = [];
	// Time metadata: the user explicitly wants the companion to see time. Kept to one line.
	const timeBits = [`now ${hhmm}`];
	if (tz) timeBits.push(tz);
	timeBits.push(`silent ${fmtDur(gap)} (feels ${temporal})`);
	if (opts.gapLabel) timeBits.push(`woke after ${opts.gapLabel} off`);
	lines.push(`time: ${timeBits.join(", ")}`);

	// Open/close awareness: when THIS body was woken, how often today, when it last closed (session.ts).
	// Distinct from the message gap above — this is PROCESS lifetime, not conversation silence.
	if (opts.session) lines.push(`body: ${opts.session}`);

	lines.push(`mood: ${moodWord(state.mood)} pad ${pad(state.mood)}${emo ? ` | ${emo}` : ""}`);
	if (drives) lines.push(`drives: ${drives}`);

	// Relationship + self, one line each, only the channels that matter right now.
	const rel = state.relationship;
	lines.push(
		`us: trust ${q(rel.trust)} close ${q(rel.attachment)} respect ${q(rel.respect)}${rel.frustration > 0.2 ? ` frust ${q(rel.frustration)}` : ""}${rel.unanswered ? ` ignored x${rel.unanswered}` : ""}`,
	);
	const ch = state.character;
	lines.push(
		`self: worth ${q(ch.selfWorth)} ease ${q(ch.selfEfficacy)} anxious ${q(ch.attachmentAnxiety)} tired ${q(state.allostasis.fatigue)}`,
	);

	// Energy governs verbosity; burst governs whether to split into several short messages.
	lines.push(`impulse: energy ${q(energy)} burst ${q(burst)} | coherence ${q(coherence)} entropy ${q(entropy)}`);

	// P1: the reply inclination is a SIGNAL the model reads and may overrule — not a decision made for it.
	if (opts.inclination) {
		const inc = opts.inclination;
		lines.push(
			`inclination: ${inc.lean} (${inc.value >= 0 ? "+" : ""}${inc.value.toFixed(2)}) — ${inc.reason}. you choose.`,
		);
	}

	// P4: specific memories this message stirred, surfaced ephemerally (the summary lives in the cache).
	if (opts.recall?.length) {
		const hits = opts.recall
			.slice(0, 5)
			.map((h) => `${h.label}${h.hop > 0 ? `~${h.hop}` : ""}${h.sealed ? "🔒" : ""}`)
			.join(", ");
		lines.push(`recalled: ${hits}`);
	}

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
