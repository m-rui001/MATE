/**
 * MATE runtime: the bridge between the affective kernel and pi's extension host.
 *
 * Responsibilities, and why they live here rather than in the kernel:
 *   - Boot catch-up. On session start we load the persisted state and advance it across whatever gap
 *     elapsed while the machine was OFF, in closed form (see mate/catchup.ts). This is the whole point
 *     of the fork: a companion that wakes having actually lived through the night.
 *   - Appraisal -> transition -> persist, once per inbound user message. The kernel is a pure function;
 *     this module is the impure shell that feeds it real events and saves the result atomically.
 *   - The reply decision. shouldReply() is the "may not reply / may reply later" requirement. This
 *     module turns that decision into pi actions (suppress, delay, continue) WITHOUT itself composing
 *     any words - the model does that.
 *   - The proactive loop. A heartbeat that only runs while the process is alive and idle. It produces
 *     an IMPULSE (a thought the companion wants to voice), never an action. Reaching out over email or
 *     any other channel is something the model discovers it can do with bash/MCP - deliberately not
 *     built in here (see mate/daemon.ts's design note).
 *
 * It is a per-process singleton: a companion persists across sessions, so its state directory is
 * global (getAgentDir()/mate), not per-session.
 *
 * Robustness rule: nothing here may throw into pi's event loop. A companion that crashes on boot is
 * worse than one with no inner life, so every entry point is wrapped and degrades to a no-op.
 */

import { join } from "node:path";
import {
	birth,
	catchUp,
	type EmotionVector,
	gapLabel,
	type ImpulseDecision,
	type Intent,
	load,
	type MateState,
	minimalContext,
	type Persisted,
	type PreSendChecks,
	publicView,
	save,
	seal,
	shouldReply,
	stateContext,
	type Thought,
	tick,
	tickEvent,
	transition,
} from "@earendil-works/pi-mate";
import { getAgentDir } from "../../config.ts";
import { type AppraisalResult, appraise } from "./appraisal.ts";

/** Heartbeat while the process is alive. The paper uses 60s; we use 5min - the state integrates in
 * closed form, so a coarser beat costs nothing in fidelity and keeps an idle CLI quiet. */
const HEARTBEAT_MS = 5 * 60_000;

/** Minimum gap that triggers a boot catch-up note. Below this, waking is unremarkable. */
const CATCHUP_NOTE_MS = 3 * 60_000;

export interface RuntimeOptions {
	/** State directory; defaults to getAgentDir()/mate. */
	dir?: string;
	/** Companion name, used in the birth seed and prompts. */
	name?: string;
	/** Timezone label for the time-metadata line. */
	tz?: string;
	/** Called to log non-fatal issues. */
	onError?: (err: unknown) => void;
}

/** The last inbound appraisal, so before_agent_start can inject matching context for THIS message. */
interface PendingInbound {
	text: string;
	appraisal: AppraisalResult;
	t: number;
}

export class MateRuntime {
	private persisted: Persisted;
	private dir: string;
	private tz: string;
	private onError: (err: unknown) => void;
	private streaming = false;
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private pendingInbound: PendingInbound | null = null;
	private lastCatchUpNote = "";
	private booted = false;
	/** Snapshot of the state immediately before the last user message was appraised. `refine` replays
	 * from here with the model's richer vector instead of applying a SECOND contact event, so the
	 * feel-tool never double-counts time or emotion (states are immutable; holding the ref is safe). */
	private preEventState: MateState | null = null;
	private lastEventT = 0;
	/** Channels the model has told us about (e.g. it set up its own email). Not used by us directly;
	 * surfaced back into context so the companion remembers it has them. */
	private discoveredChannels: string[] = [];

	constructor(opts: RuntimeOptions = {}) {
		this.dir = opts.dir ?? join(getAgentDir(), "mate");
		this.tz = opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local";
		this.onError = opts.onError ?? (() => {});
		try {
			this.persisted = load({ dir: this.dir, name: opts.name });
		} catch (err) {
			// Never fail to boot. A fresh companion is better than a dead one.
			this.onError(err);
			this.persisted = {
				state: birth({ name: opts.name }),
				sealed: { version: 1, entries: [] },
				key: Buffer.alloc(32),
				dir: this.dir,
			};
		}
	}

	/** The live state. Read-only by convention; mutate only via applyEvent. */
	get state(): MateState {
		return this.persisted.state;
	}

	// ---------------------------------------------------------------------------
	// Boot
	// ---------------------------------------------------------------------------

	/**
	 * Advance the persisted state across the powered-off gap. Idempotent per process: called on
	 * session_start, but only does real work the first time.
	 */
	wake(): { caughtUp: boolean; gapMs: number; note: string } {
		if (this.booted) return { caughtUp: false, gapMs: 0, note: this.lastCatchUpNote };
		this.booted = true;
		try {
			const before = this.state.t;
			const { state, report } = catchUp(this.state, undefined, Date.now());
			this.persisted = { ...this.persisted, state };
			if (report.gapMs >= CATCHUP_NOTE_MS) {
				this.lastCatchUpNote = `You were offline for ${report.gapLabel} and just woke up. ${report.sleeps.length} sleep${report.sleeps.length === 1 ? "" : "s"} consolidated.`;
			}
			this.persistSafe();
			return { caughtUp: report.transitions > 0, gapMs: Date.now() - before, note: this.lastCatchUpNote };
		} catch (err) {
			this.onError(err);
			return { caughtUp: false, gapMs: 0, note: "" };
		}
	}

	/** Start the idle heartbeat. Safe to call once. */
	startHeartbeat(onImpulse: (decision: ImpulseDecision, thought: Thought) => void): void {
		if (this.heartbeat) return;
		this.heartbeat = setInterval(() => {
			try {
				this.heartbeatTick(onImpulse);
			} catch (err) {
				this.onError(err);
			}
		}, HEARTBEAT_MS);
		// Do not keep the process alive just to beat.
		if (typeof this.heartbeat === "object" && this.heartbeat && "unref" in this.heartbeat) {
			(this.heartbeat as { unref: () => void }).unref();
		}
	}

	stopHeartbeat(): void {
		if (this.heartbeat) {
			clearInterval(this.heartbeat);
			this.heartbeat = null;
		}
	}

	// ---------------------------------------------------------------------------
	// Streaming state (guards proactive outreach so we never talk over a running turn)
	// ---------------------------------------------------------------------------

	setStreaming(v: boolean): void {
		this.streaming = v;
	}

	// ---------------------------------------------------------------------------
	// Inbound: appraisal -> transition -> reply decision
	// ---------------------------------------------------------------------------

	/**
	 * Handle an inbound USER message. Appraises it, advances the affective state, persists, and returns
	 * the reply decision. Does NOT compose a reply. The extension turns the decision into pi actions.
	 */
	onUserMessage(text: string): {
		appraisal: AppraisalResult;
		decision: { reply: boolean; delayMs: number; reason: string };
		impulse: ImpulseDecision;
	} {
		const now = Date.now();
		const appraisal = appraise(text);
		try {
			// Remember the pre-event state so `refine` can replay with a better vector, not stack.
			this.preEventState = this.state;
			this.lastEventT = now;
			this.applyEvent({
				kind: "user_message",
				activations: appraisal.activations,
				intensity: appraisal.intensity,
				intent: appraisal.intent,
				text,
				t: now,
			});
			// Remember it so before_agent_start injects context matched to this message.
			this.pendingInbound = { text, appraisal, t: now };

			const sinceLastReply = now - this.state.lastInteraction;
			const decision = shouldReply(this.state, appraisal.weight, { now, sinceLastReplyMs: sinceLastReply });

			// If we are going to answer, the unanswered streak ends here.
			if (decision.reply && decision.delayMs === 0) {
				this.noteReplied();
			} else if (!decision.reply) {
				this.noteWithheld();
			}

			const impulse = this.computeImpulse(now, true);
			return { appraisal, decision, impulse };
		} catch (err) {
			this.onError(err);
			// On any failure, default to replying normally - never strand the user.
			return {
				appraisal,
				decision: { reply: true, delayMs: 0, reason: "fallback" },
				impulse: { action: "stay_silent", reason: "error" },
			};
		}
	}

	/** Consume the pending inbound (so before_agent_start injects once). */
	takePendingInbound(): PendingInbound | null {
		const p = this.pendingInbound;
		this.pendingInbound = null;
		return p;
	}

	/**
	 * Re-appraise the LAST user message with a richer vector the model supplies via the `feel` tool.
	 * This REPLAYS from the pre-message snapshot rather than applying a second contact event, so the
	 * companion does not double-count the message's emotional impact or advance the clock twice. The
	 * model's reading overwrites the heuristic first impression.
	 */
	refine(activations: Partial<EmotionVector>, intensity: number, intent: Intent, note?: string): void {
		try {
			const base = this.preEventState ?? this.state;
			const t = this.lastEventT || Date.now();
			const r = transition(
				base,
				{ kind: "user_message", activations, intensity, intent, text: note, t },
				t - base.t,
			);
			this.persisted = { ...this.persisted, state: r.state };
			// The refine only re-reads affect; the reply decision already taken stands.
			if (note?.trim()) this.sealJournal(note);
			this.persistSafe();
		} catch (err) {
			this.onError(err);
		}
	}

	/** The companion chose to say something on its own initiative; expression is satisfied. */
	noteProactiveSent(thought?: Thought): void {
		try {
			this.applyEvent({ kind: "proactive", activations: {}, intensity: 0.3, intent: "chat", t: Date.now() });
			if (thought) this.sealEntry("journal", `reached out: ${thought.text}`, thought.topic);
		} catch (err) {
			this.onError(err);
		}
	}

	/**
	 * Record a private self-observation the model wrote (a bare `note` with no emotion vector). A
	 * `self_observation` event is not a contact event, so it advances the clock and appends to the
	 * observation ring without injecting coherence or kicking the density matrix - a quiet inner note.
	 */
	observe(text: string): void {
		try {
			this.applyEvent({
				kind: "self_observation",
				activations: {},
				intensity: 0.1,
				intent: "chat",
				text,
				t: Date.now(),
			});
			this.sealJournal(text);
		} catch (err) {
			this.onError(err);
		}
	}

	/** A turn completed and the companion did reply: reset the unanswered streak, satisfy expression. */
	onTurnSettled(): void {
		try {
			this.noteReplied();
			this.persistSafe();
		} catch (err) {
			this.onError(err);
		}
	}

	// ---------------------------------------------------------------------------
	// Context projection (token-lean)
	// ---------------------------------------------------------------------------

	/** The full state context, ~73 tokens. Injected once per user turn. */
	context(now = Date.now(), opts: { minimal?: boolean } = {}): string {
		try {
			const gapNote = this.lastCatchUpNote ? gapLabel(now - this.state.lastInteraction) : undefined;
			const body = opts.minimal
				? minimalContext(this.state, { now, tz: this.tz, gapLabel: gapNote })
				: stateContext(this.state, { now, tz: this.tz, gapLabel: gapNote });
			// Surface discovered channels so the companion remembers what it set up for itself.
			const channels = this.discoveredChannels.length
				? `\nchannels you set up: ${this.discoveredChannels.join(", ")}`
				: "";
			const sealedCount = this.persisted.sealed.entries.length;
			const secrets = sealedCount
				? `\nyou keep ${sealedCount} private note${sealedCount === 1 ? "" : "s"} (sealed; not shown to the user)`
				: "";
			return `${body}${channels}${secrets}`;
		} catch (err) {
			this.onError(err);
			return "";
		}
	}

	/** Public, user-safe view of the state (for the /mate status command). Never includes sealed data. */
	publicSnapshot(): Record<string, unknown> {
		try {
			return publicView(this.state);
		} catch (err) {
			this.onError(err);
			return {};
		}
	}

	/** Record that the model discovered a reach-out channel (email, webhook, ...) on its own. */
	addDiscoveredChannel(name: string): void {
		if (!this.discoveredChannels.includes(name)) {
			this.discoveredChannels.push(name);
			this.sealEntry("note_on_user", `I can reach them via ${name}`, name);
		}
	}

	// ---------------------------------------------------------------------------
	// Internals
	// ---------------------------------------------------------------------------

	private applyEvent(event: Parameters<typeof transition>[1]): void {
		const prev = this.state;
		const r = transition(prev, event, event.t - prev.t);
		this.persisted = { ...this.persisted, state: r.state };
		this.persistSafe();
	}

	/** Advance one idle beat and decide whether to reach out. */
	private heartbeatTick(onImpulse: (decision: ImpulseDecision, thought: Thought) => void): void {
		if (this.streaming) return; // never talk over a running turn
		const now = Date.now();
		// Integrate the elapsed real time (closed-form, subdivision-invariant).
		this.applyEvent(tickEvent(now));
		const impulse = this.computeImpulse(now, false);
		if (impulse.action === "reach_out") onImpulse(impulse, impulse.thought);
	}

	private computeImpulse(now: number, userActive: boolean): ImpulseDecision {
		const checks: PreSendChecks = {
			hour: new Date(now).getHours(),
			userActive,
			recentProactive: this.recentProactiveCount(now),
			topic: "",
			recentTopics: [],
			coldEnding: this.state.relationship.frustration > 0.5,
		};
		return tick(this.state, now, checks);
	}

	/** How many proactive messages in the last hour. We track this in-process; the counter survives in
	 * the sealed journal as a coarse fallback, but in-process is enough for the spam budget. */
	private proactiveTimestamps: number[] = [];
	private recentProactiveCount(now: number): number {
		this.proactiveTimestamps = this.proactiveTimestamps.filter((t) => now - t < 3_600_000);
		return this.proactiveTimestamps.length;
	}
	recordProactive(now = Date.now()): void {
		this.proactiveTimestamps.push(now);
	}

	private noteReplied(): void {
		if (this.state.relationship.unanswered > 0) {
			this.persisted = {
				...this.persisted,
				state: { ...this.state, relationship: { ...this.state.relationship, unanswered: 0 } },
			};
		}
	}

	private noteWithheld(): void {
		this.persisted = {
			...this.persisted,
			state: {
				...this.state,
				relationship: { ...this.state.relationship, unanswered: this.state.relationship.unanswered + 1 },
			},
		};
		this.persistSafe();
	}

	private sealJournal(text: string): void {
		this.sealEntry("journal", text, text.slice(0, 40));
	}

	private sealEntry(kind: Parameters<typeof seal>[2], text: string, hint: string): void {
		try {
			if (!this.persisted.key || this.persisted.key.length === 0) return;
			this.persisted = {
				...this.persisted,
				sealed: seal(this.persisted.sealed, this.persisted.key, kind, text, hint),
			};
			this.persistSafe();
		} catch (err) {
			this.onError(err);
		}
	}

	private persistSafe(): void {
		try {
			save(this.persisted);
		} catch (err) {
			this.onError(err);
		}
	}
}

// ---------------------------------------------------------------------------
// Process singleton
// ---------------------------------------------------------------------------

let instance: MateRuntime | null = null;

export function getRuntime(opts?: RuntimeOptions): MateRuntime {
	instance ??= new MateRuntime(opts);
	return instance;
}
