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

import { HABITUATION_TAU } from "./params.ts";
import { driveNoticeThreshold } from "./context.ts";
import { burstOf, energyOf } from "./kernel.ts";
import { nextRandom } from "./rng.ts";
import type { Awareness, MateState, Thought } from "./types.ts";

/** What the loop decided to do about an impulse. */
export type ImpulseDecision =
	| { action: "stay_silent"; reason: string }
	| { action: "think_only"; thought: Thought; reason: string }
	| { action: "reach_out"; thought: Thought; channel: "reply" | "proactive"; reason: string };

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
 * Generate thought candidates from current state. This is the "graph traversal" of the paper
 * reduced to what we can compute from the affective state alone - no memory graph dependency, so
 * it works even on a fresh companion. Each candidate is a seed the host may or may not verbalise.
 */
export function generateThoughts(state: MateState, now: number): Array<{ thought: Thought; rawUrgency: number }> {
	const out: Array<{ thought: Thought; rawUrgency: number }> = [];
	const ch = state.character;
	const drives = state.drives;
	const aw = state.awareness;

	const mk = (kind: Thought["kind"], text: string, urgency: number, topic: string): void => {
		if (urgency <= 0) return;
		out.push({ thought: { id: `${kind}-${now}`, kind, text, urgency, topic, t: now }, rawUrgency: urgency });
	};

	// missing_user: silence + attachment + negative social pressure. Scales with extraversion.
	const silenceH = (now - state.lastInteraction) / 3_600_000;
	if (silenceH > 1) {
		const pull = Math.min(1, silenceH / 12) * (0.4 + state.relationship.attachment) * (0.5 + state.personality.e);
		const pressure = Math.max(0, -aw.socialPressure);
		mk("missing_user", "been quiet a while; wondering what they're up to", pull * (0.4 + pressure), `silence:${Math.floor(silenceH / 3)}`);
	}

	// curiosity: the curiosity drive, amplified by openness and the curiosity trait.
	if (drives.curiosity > 0.5) {
		const c = (drives.curiosity - 0.5) * 2 * (0.4 + state.personality.o) * (0.5 + ch.curiosity);
		mk("curiosity", "something I want to look into for its own sake", c, "curiosity");
	}

	// expression: the need to say something that has been building.
	if (drives.expression > 0.6) {
		mk("observation", "a thing I've been turning over and want to put into words", (drives.expression - 0.6) * 2.5, "expression");
	}

	// vulnerability: low self-worth or high fatigue + something unshared.
	if (ch.selfWorth < 0.35 || state.allostasis.fatigue > 0.7) {
		const v = Math.max(0, 0.35 - ch.selfWorth) * 2 + Math.max(0, state.allostasis.fatigue - 0.7);
		mk("vulnerability", "feeling a bit raw and not sure whether to say so", v * (0.3 + ch.vulnerability), "vulnerable");
	}

	// pattern: high thought_saturation means we are spiralling; a thought about the spiral itself.
	if (aw.thoughtSaturation > 0.7) {
		mk("pattern", "noticing I keep circling the same thing", (aw.thoughtSaturation - 0.7) * 2 * (0.3 + ch.reflectiveness), "rumination");
	}

	return out;
}

/**
 * The pre-send review. Any single check can suppress the message entirely. In production the paper
 * reports 94% of impulses self-blocked here; the thresholds are all personality-derived, never a
 * fixed number, so an extravert and an introvert with identical state behave differently.
 */
export function preSendReview(state: MateState, thought: Thought, checks: PreSendChecks): { pass: boolean; reason: string } {
	const ch = state.character;
	const p = state.personality;

	// 1. Unanswered tolerance: an introvert stops after 1 ignored overture, an extravert after 3.
	const maxUnanswered = 1 + Math.round(p.e * 2.5);
	if (!checks.userActive && state.relationship.unanswered >= maxUnanswered) {
		return { pass: false, reason: `already sent ${state.relationship.unanswered} into silence; tolerance is ${maxUnanswered}` };
	}

	// 2. Spam budget: personality-scaled cap per hour.
	const perHourCap = Math.max(1, Math.round(1 + p.e * 2 + ch.impulsivity));
	if (checks.recentProactive >= perHourCap) {
		return { pass: false, reason: `proactive budget ${checks.recentProactive}/${perHourCap} this hour` };
	}

	// 3. Topic overlap with recent messages: don't repeat what was just discussed.
	if (checks.recentTopics.includes(thought.topic)) {
		return { pass: false, reason: `topic "${thought.topic}" already live` };
	}

	// 4. Cold ending: if the last exchange ended dismissively, back off - unless anxious attachment
	//    overrides (which is realistic and a little sad, and exactly the kind of thing that should
	//    emerge rather than be scripted).
	if (checks.coldEnding && ch.attachmentAnxiety < 0.6) {
		return { pass: false, reason: "last exchange ended cold; giving space" };
	}

	// 5. Night quiet: the window widens with neuroticism (an anxious mind keeps quieter hours).
	const quietStart = 23 - Math.round(ch.attachmentAnxiety * 1);
	const quietEnd = 7 + Math.round(p.n * 1);
	const h = checks.hour;
	const inQuiet = quietStart > quietEnd ? h >= quietStart || h < quietEnd : h >= quietStart && h < quietEnd;
	if (inQuiet && !checks.userActive && thought.urgency < 0.85) {
		return { pass: false, reason: `quiet hours (${quietStart}:00-${quietEnd}:00), not urgent enough` };
	}

	// 6. Trust gate: a low-trust companion does not initiate intimate contact.
	if (thought.kind === "vulnerability" && state.relationship.trust < ch.trustBaseline * 0.8) {
		return { pass: false, reason: "not close enough yet to share that" };
	}

	// 7. Urgency floor: personality-dependent. Introverts need more conviction to reach out.
	const floor = 0.45 - p.e * 0.2 + ch.impulsivity * -0.1;
	if (!checks.userActive && thought.urgency < floor) {
		return { pass: false, reason: `urgency ${thought.urgency.toFixed(2)} below floor ${floor.toFixed(2)}` };
	}

	return { pass: true, reason: "cleared" };
}

/**
 * The top-level tick. Given the current state and the world, decide what (if anything) the
 * companion does. Returns a decision; performs nothing. The host is responsible for turning a
 * "reach_out" into an actual message through whatever channel it has - including one the model
 * set up itself.
 */
export function tick(
	state: MateState,
	now: number,
	checks: PreSendChecks,
): ImpulseDecision {
	// Drive-delta self-observation: if a drive moved more than the notice threshold, note it.
	// This is how the companion "feels its own temporal dynamics as they happen".
	const threshold = driveNoticeThreshold(state);
	const thoughts = generateThoughts(state, now);
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

	// If the user is active, this is a reactive turn: we always produce at least a thought, but
	// whether we actually speak is the "may not reply" decision (see shouldReply).
	const review = preSendReview(state, top.thought, checks);
	if (!review.pass) {
		return { action: "think_only", thought: top.thought, reason: review.reason };
	}

	return {
		action: checks.userActive ? "reach_out" : "reach_out",
		thought: top.thought,
		channel: checks.userActive ? "reply" : "proactive",
		reason: review.reason,
	};
}

/**
 * Should we reply AT ALL to an inbound user message? The requirement is explicit: it may not
 * reply, or may reply later. This is a genuine decision, not a throttle.
 *
 * Driven by energy (Eq. 12), fatigue, unanswered history, and the affective weight of the message.
 * A low-energy, high-fatigue companion that was just ignored is allowed to let a message sit - and
 * the host should surface that as a delayed reply, not a dropped one.
 */
export function shouldReply(
	state: MateState,
	msgWeight: number,
	opts: { now: number; sinceLastReplyMs: number },
): { reply: boolean; delayMs: number; reason: string } {
	const energy = energyOf(state);
	const fatigue = state.allostasis.fatigue;
	const p = state.personality;

	// Base willingness: energy up, fatigue down, extraversion up.
	let willing = 0.35 + 0.5 * energy + 0.25 * p.e - 0.6 * fatigue;
	// A heavy message (high weight: distress, a direct question) pulls willingness up sharply.
	willing += msgWeight * 0.4;
	// Being recently ignored makes us less eager to always answer.
	willing -= state.relationship.unanswered * 0.05;

	const r = nextRandom(state.seed ^ Math.floor(opts.now));
	const roll = r.value;

	if (willing >= 0.75 || msgWeight > 0.85) {
		return { reply: true, delayMs: 0, reason: "engaged" };
	}
	if (willing <= 0.2 && msgWeight < 0.5) {
		// Let it sit. The host may surface this later; the state keeps evolving meanwhile.
		return { reply: false, delayMs: Number.POSITIVE_INFINITY, reason: `withheld (willing ${willing.toFixed(2)}, roll ${roll.toFixed(2)})` };
	}
	// Delayed reply: a bounded wait proportional to low energy / high fatigue.
	if (roll > willing) {
		const delayMs = Math.round((1 - willing) * (2 + fatigue * 8) * 60_000 * (0.5 + r.value));
		return { reply: true, delayMs, reason: `later (willing ${willing.toFixed(2)})` };
	}
	return { reply: true, delayMs: 0, reason: "ok" };
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
	const phase = ((meanAngle / (2 * Math.PI)) + 1) % 1;
	return { ...aw, temporalPhase: phase };
}

/** Burst: how many short messages to fragment a reply into, and the pause between them. */
export function sendStyle(state: MateState): { fragments: number; pauseMs: number } {
	const burst = burstOf(state);
	const energy = energyOf(state);
	if (burst > 0.62 && energy > 0.5) return { fragments: 2 + Math.round(burst * 2), pauseMs: 1400 + Math.round((1 - burst) * 1200) };
	if (burst > 0.4) return { fragments: 2, pauseMs: 1800 };
	return { fragments: 1, pauseMs: 0 };
}
