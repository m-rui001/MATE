/**
 * The autonomous loop (MATE daemon), rebuilt for a machine that powers off.
 *
 * The paper runs a 60-second heartbeat forever and generates thoughts between messages, with a
 * pre-send review that self-blocks 98.5% of impulses. Two things are preserved and one is changed:
 *
 *   PRESERVED  - thinking is graph/state-driven, not scheduled. The companion writes because it
 *                thought something worth sharing, not because N hours elapsed. social_pressure
 *                going negative under silence is the impulse; drives and habituation shape it.
 *   PRESERVED  - the pre-send review. Most impulses die internally. This is what keeps a proactive
 *                companion from becoming a spam bot.
 *   CHANGED    - the heartbeat is not assumed to have been running. On boot, catch-up (catchup.ts)
 *                advances the state across the gap in closed form; the daemon then resumes ticking
 *                only while the process is actually alive.
 *
 * Crucially, this module produces DECISIONS and THOUGHTS. It does not send email, does not open a
 * socket, does not know how the user is reached. The requirement was that reaching out (email, a
 * note, anything) is something the companion figures out itself using its bash / MCP / plugin
 * powers, not a built-in feature. So the daemon's output is an impulse plus a thought; the
 * host decides whether to give it a channel, and the model decides what to do with it.
 */

import { type Lang, linesFor } from "./i18n.ts";
import { boredomOf, burstOf, energyOf } from "./kernel.ts";
import { type MemoryGraph, recall, topNodes } from "./memory.ts";
import { HABITUATION_TAU } from "./params.ts";
import type { Awareness, MateState, Thought } from "./types.ts";

/** What the loop decided to do about an impulse. */
export type ImpulseDecision =
	| { action: "stay_silent"; reason: string }
	| { action: "think_only"; thought: Thought; reason: string; advisory: string[] }
	| {
			action: "reach_out";
			thought: Thought;
			channel: "reply" | "proactive";
			reason: string;
			/** Content-level cautions the review did NOT enforce — the model decides against them. */
			advisory: string[];
	  };

export interface PreSendChecks {
	/** Local hour, 0-23, for night-quiet reasoning. */
	hour: number;
	/** Is the user currently active (a message just arrived)? */
	userActive: boolean;
	/** Proactive messages already sent in the last hour. */
	recentProactive: number;
	/** Topic of the candidate thought, for freshness/overlap checks. */
	topic: string;
	/** Topics of the last few messages, for overlap suppression. */
	recentTopics: string[];
	/** Was the last exchange dismissive / did it end coldly? */
	coldEnding: boolean;
}

/**
 * Dual-process habituation gate. A topic recently thought about has low novelty and is suppressed;
 * novelty recovers over time. H(t) = t/(t+tau) is the recovery, S(t) the fast System-1 decay.
 * Returns the gated urgency and the updated trace.
 */
export function habituate(
	state: MateState,
	topic: string,
	rawUrgency: number,
	now: number,
): { urgency: number; trace: { s: number; t: number } } {
	const prev = state.habituation[topic];
	const dt = prev ? now - prev.t : Number.POSITIVE_INFINITY;
	const H = dt === Number.POSITIVE_INFINITY ? 1 : dt / (dt + HABITUATION_TAU);
	const S = prev ? prev.s * Math.exp(-dt / (2 * HABITUATION_TAU)) : 0;
	// Novelty recovers toward 1; a strong prior trace (S) pulls urgency down.
	const novelty = H * (1 - 0.6 * S);
	const urgency = rawUrgency * (0.4 + 0.6 * novelty);
	return { urgency, trace: { s: Math.min(1, S + 0.25), t: now } };
}

/**
 * Generate thought candidates from current state. The paper's "graph traversal" now has a real
 * graph to traverse: the associative memory (memory.ts). Each affective candidate below is GROUNDed
 * in a recalled concept where the graph has one, so the companion has a specific thing to feel
 * about, not just a mood. The `memory` argument is optional so a fresh/broken graph still produces
 * mood-driven thoughts (the previous behaviour) — the graph enriches, it never gates.
 */
export function generateThoughts(
	state: MateState,
	now: number,
	memory?: MemoryGraph,
	lang: Lang = "en",
): Array<{ thought: Thought; rawUrgency: number }> {
	const L = linesFor(lang);
	const out: Array<{ thought: Thought; rawUrgency: number }> = [];
	const ch = state.character;
	const drives = state.drives;
	const aw = state.awareness;

	// A concrete "on my mind" seed: the strongest recent concept, if we have a graph. Used to turn
	// abstract urges into about-something thoughts ("wondering what they're up to" → "…about X").
	const seed = memory ? topNodes(memory, now, 1)[0] : undefined;
	const seedLabel = seed ? (memory!.nodes[seed]?.label ?? "") : "";

	// A single grounded line: fold the recalled concept into the thought's topic so habituation and
	// the pre-send freshness check operate on a REAL subject, not a generic bucket.
	const topic = (base: string): string => (seedLabel ? `${base}:${seedLabel}` : base);

	const mk = (kind: Thought["kind"], text: string, urgency: number, top: string): void => {
		if (urgency <= 0) return;
		out.push({
			thought: { id: `${kind}-${now}`, kind, text, urgency, topic: topic(top), t: now },
			rawUrgency: urgency,
		});
	};

	// missing_user: silence + attachment + negative social pressure. Scales with extraversion.
	const silenceH = (now - state.lastInteraction) / 3_600_000;
	if (silenceH > 1) {
		const pull = Math.min(1, silenceH / 12) * (0.4 + state.relationship.attachment) * (0.5 + state.personality.e);
		const pressure = Math.max(0, -aw.socialPressure);
		mk("missing_user", L.thMissing(seedLabel), pull * (0.4 + pressure), `silence:${Math.floor(silenceH / 3)}`);
	}

	// curiosity: the curiosity drive, amplified by openness and the curiosity trait. Grounded in a
	// recalled node when possible — curiosity about SOMETHING specific beats free-floating itch.
	if (drives.curiosity > 0.5) {
		const c = (drives.curiosity - 0.5) * 2 * (0.4 + state.personality.o) * (0.5 + ch.curiosity);
		// Widen recall to top-1 concept that ISN'T the silence seed, so thoughts vary.
		const curious = memory
			? recall(memory, { seeds: topNodes(memory, now, 4), now, limit: 4 }).find((h) => h.label !== seedLabel)
			: undefined;
		mk("curiosity", L.thCuriosity(curious?.label ?? ""), c, curious ? `curiosity:${curious.label}` : "curiosity");
	}

	// expression: the need to say something that has been building.
	if (drives.expression > 0.6) {
		mk("observation", L.thExpression(seedLabel), (drives.expression - 0.6) * 2.5, "expression");
	}

	// boredom: under-stimulation, restless for something to happen. Distinct from curiosity (a
	// specific unknown) and missing_user (this person) — the itch is "nothing new is going on". It
	// is a DERIVED signal (see kernel.boredomOf): high when the world has been playing out exactly
	// as predicted for a while, and collapsed by genuine novelty.
	const boredom = boredomOf(state, now);
	if (boredom > 0.6) {
		const b = (boredom - 0.6) * 2.5 * (0.4 + state.personality.o);
		mk("curiosity", L.thBoredom(seedLabel), b, "boredom");
	}

	// vulnerability: low self-worth or high fatigue + something unshared.
	if (ch.selfWorth < 0.35 || state.allostasis.fatigue > 0.7) {
		const v = Math.max(0, 0.35 - ch.selfWorth) * 2 + Math.max(0, state.allostasis.fatigue - 0.7);
		mk("vulnerability", L.thVulnerability, v * (0.3 + ch.vulnerability), "vulnerable");
	}

	// pattern: high thought_saturation means we are spiralling; a thought about the spiral itself.
	// Grounded: name what we are circling, because a rumination about a real node is actionable.
	if (aw.thoughtSaturation > 0.7) {
		const circling = seedLabel || L.thNone;
		mk("pattern", L.thPattern(circling), (aw.thoughtSaturation - 0.7) * 2 * (0.3 + ch.reflectiveness), "rumination");
	}

	return out;
}

/**
 * The pre-send review, split along the agency principle (P1: "减少内置模式").
 *
 * Two kinds of check, deliberately separated:
 *   - RATE/COST (blocked): objective hygiene the MODEL cannot see — the hourly spam budget and the
 *     unanswered-overture tolerance. These stay hard, because they protect the USER from a runaway
 *     proactive loop. They are the only suppression authority left here.
 *   - JUDGMENT (advisory): everything about HOW the message would land — repetition, a cold ending,
 *     quiet hours, whether it's intimate enough to share, whether the conviction is there. These no
 *     longer veto. They become one-line notes handed to the model, which is better placed than a
 *     formula to feel its way to a decision. This is the shift from "the kernel self-blocks 94%" to
 *     "the mind is told what to weigh and decides."
 */
export interface PreSendReview {
	/** An enforced rate/cost stop. If present, the impulse does not fire, with this reason. */
	blocked: string | null;
	/** Content-level cautions to surface to the model, never to enforce. */
	advisory: string[];
	reason: string;
}

export function preSendReview(
	state: MateState,
	thought: Thought,
	checks: PreSendChecks,
	lang: Lang = "en",
): PreSendReview {
	const L = linesFor(lang);
	const ch = state.character;
	const p = state.personality;
	const advisory: string[] = [];

	// --- RATE / COST: hard stops the model cannot observe. ---

	// Unanswered tolerance: an introvert stops reaching into silence after 1, an extravert after ~3.
	const maxUnanswered = 1 + Math.round(p.e * 2.5);
	if (!checks.userActive && state.relationship.unanswered >= maxUnanswered) {
		return {
			blocked: `already sent ${state.relationship.unanswered} into silence; tolerance is ${maxUnanswered}`,
			advisory,
			reason: "rate-limited",
		};
	}

	// Spam budget: personality-scaled cap per hour.
	const perHourCap = Math.max(1, Math.round(1 + p.e * 2 + ch.impulsivity));
	if (checks.recentProactive >= perHourCap) {
		return {
			blocked: `proactive budget ${checks.recentProactive}/${perHourCap} this hour`,
			advisory,
			reason: "rate-limited",
		};
	}

	// --- JUDGMENT: advisories the model weighs and can overrule. ---

	if (checks.recentTopics.includes(thought.topic)) {
		advisory.push(L.adRecentTopic);
	}

	if (checks.coldEnding) {
		advisory.push(ch.attachmentAnxiety >= 0.6 ? L.adColdAnxious : L.adColdSpace);
	}

	// Night quiet: window widens with neuroticism (an anxious mind keeps quieter hours).
	const quietStart = 23 - Math.round(ch.attachmentAnxiety * 1);
	const quietEnd = 7 + Math.round(p.n * 1);
	const h = checks.hour;
	const inQuiet = quietStart > quietEnd ? h >= quietStart || h < quietEnd : h >= quietStart && h < quietEnd;
	if (inQuiet && !checks.userActive) {
		advisory.push(L.adQuietHours(quietStart, quietEnd));
	}

	// Trust/intimacy: a low-trust companion sharing something vulnerable is a judgment call, not a ban.
	if (thought.kind === "vulnerability" && state.relationship.trust < ch.trustBaseline * 0.8) {
		advisory.push(L.adLowTrust);
	}

	// Conviction floor as a nudge, not a gate.
	const floor = 0.45 - p.e * 0.2 - ch.impulsivity * 0.1;
	if (!checks.userActive && thought.urgency < floor) {
		advisory.push(L.adFaintPull(thought.urgency.toFixed(2), floor.toFixed(2)));
	}

	return { blocked: null, advisory, reason: advisory.length ? "weighed" : "cleared" };
}

/**
 * The top-level tick. Given the current state, the memory graph, and the world, decide whether an
 * impulse is worth voicing. Returns a decision; performs nothing. The host turns a "reach_out" into
 * an actual message through whatever channel it has — including one the model set up itself.
 */
export function tick(
	state: MateState,
	now: number,
	checks: PreSendChecks,
	memory?: MemoryGraph,
	lang: Lang = "en",
): ImpulseDecision {
	const thoughts = generateThoughts(state, now, memory, lang);
	if (thoughts.length === 0) {
		return { action: "stay_silent", reason: "no active impulse" };
	}

	// Habituate and rank.
	const gated = thoughts
		.map(({ thought, rawUrgency }) => {
			const h = habituate(state, thought.topic, rawUrgency, now);
			return { thought: { ...thought, urgency: h.urgency }, trace: h.trace };
		})
		.sort((a, b) => b.thought.urgency - a.thought.urgency);

	const top = gated[0];

	const review = preSendReview(state, top.thought, checks, lang);
	if (review.blocked) {
		// Rate/cost stop: keep the thought as inner life, but it does not fire. The advisory notes still
		// ride along so the model sees what it was weighing.
		return { action: "think_only", thought: top.thought, reason: review.blocked, advisory: review.advisory };
	}

	// Not rate-limited. The impulse surfaces as a candidate to the model — whether to voice it, and how,
	// is the model's call (P1). Advisory cautions travel with it.
	return {
		action: "reach_out",
		thought: top.thought,
		channel: checks.userActive ? "reply" : "proactive",
		reason: review.reason,
		advisory: review.advisory,
	};
}

/**
 * How inclined the companion is to answer an inbound message RIGHT NOW.
 *
 * This used to be `shouldReply`, a hard gate with a dice roll that could drop or defer a message in
 * the runtime. That violated the design principle the user set: "原则上减少内置模式，而是给它更多的选择空间"
 * - reduce built-in modes, give the model more room to choose. So this is now an ADVISORY PRIOR: a
 * single number + a plain-language lean + a one-line reason, surfaced into the prompt so the MODEL
 * decides whether to answer, answer briefly, or let it sit. The runtime no longer suppresses a turn
 * based on it; it never returns a delay/drop action to the host, only a signal to the mind.
 *
 * The affective math is unchanged in spirit (energy, fatigue, extraversion, message weight, unanswered
 * history) — only the authority over the outcome has moved from the kernel to the model.
 */
export interface ReplyInclination {
	/** Willingness in roughly [-1, 1]: strongly not-now .. strongly right-now. */
	value: number;
	/** A short human handle the model can read as a lean, not a command. */
	lean: "eager" | "open" | "muted" | "withdrawn";
	/** One-line why, in the companion's own terms. */
	reason: string;
}

export function replyInclination(state: MateState, msgWeight: number, lang: Lang = "en"): ReplyInclination {
	const L = linesFor(lang);
	const energy = energyOf(state);
	const fatigue = state.allostasis.fatigue;
	const p = state.personality;

	// Base willingness: energy up, fatigue down, extraversion up; heavy messages (distress, a direct
	// question) pull it up; a run of unanswered overtures cools it. Same terms as the old gate.
	let willing = 0.35 + 0.5 * energy + 0.25 * p.e - 0.6 * fatigue;
	willing += msgWeight * 0.4;
	willing -= state.relationship.unanswered * 0.05;

	// Map [0..1]-ish willingness to a centered [-1..1] signal, clamped.
	const value = Math.max(-1, Math.min(1, (willing - 0.5) * 2));
	const lean: ReplyInclination["lean"] =
		value > 0.35 ? "eager" : value > 0 ? "open" : value > -0.4 ? "muted" : "withdrawn";

	const reason =
		lean === "withdrawn" ? L.reWithdrawn : lean === "muted" ? L.reMuted : lean === "open" ? L.reOpen : L.reEager;

	return { value, lean, reason };
}

/** Update the awareness field's temporal_phase from observed user activity hours (0-23 -> 0-1). */
export function learnTemporalPhase(aw: Awareness, observedHours: number[]): Awareness {
	if (observedHours.length === 0) return aw;
	// Circular mean of activity hours, mapped to a phase.
	let sx = 0;
	let sy = 0;
	for (const h of observedHours) {
		const a = (h / 24) * 2 * Math.PI;
		sx += Math.cos(a);
		sy += Math.sin(a);
	}
	const meanAngle = Math.atan2(sy / observedHours.length, sx / observedHours.length);
	const phase = (meanAngle / (2 * Math.PI) + 1) % 1;
	return { ...aw, temporalPhase: phase };
}

/** Burst: how many short messages to fragment a reply into, and the pause between them. */
export function sendStyle(state: MateState): { fragments: number; pauseMs: number } {
	const burst = burstOf(state);
	const energy = energyOf(state);
	if (burst > 0.62 && energy > 0.5)
		return { fragments: 2 + Math.round(burst * 2), pauseMs: 1400 + Math.round((1 - burst) * 1200) };
	if (burst > 0.4) return { fragments: 2, pauseMs: 1800 };
	return { fragments: 1, pauseMs: 0 };
}
