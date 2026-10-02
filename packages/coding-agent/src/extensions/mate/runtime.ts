/**
 * MATE runtime: the bridge between the affective kernel and pi's extension host.
 *
 * Responsibilities, and why they live here rather than in the kernel:
 *   - Boot catch-up. On session start we load the persisted state and advance it across whatever gap
 *     elapsed while the machine was OFF, in closed form (see mate/catchup.ts). This is the whole point
 *     of the fork: a companion that wakes having actually lived through the night.
 *   - Appraisal -> transition -> persist, once per inbound user message. The kernel is a pure function;
 *     this module is the impure shell that feeds it real events and saves the result atomically. Each
 *     inbound message is also folded into the associative memory graph (P4), which grounds later thinking.
 *   - The reply lean. Per P1 ("减少内置模式"), the kernel no longer gates replies. `replyInclination`
 *     returns an ADVISORY signal that the model reads and may overrule; the model, not this code,
 *     decides whether to answer, answer briefly, or let it sit. The `context` projection surfaces the
 *     lean so it is felt, not enforced.
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
	closeSession,
	consolidate,
	type EmotionVector,
	emptyMemory,
	emptySessions,
	encode,
	gapLabel,
	type ImpulseDecision,
	type Intent,
	load,
	type MateState,
	type MemoryGraph,
	minimalContext,
	nodeKey,
	openSession,
	type Persisted,
	type PreSendChecks,
	publicView,
	type RecallHit,
	type ReplyInclination,
	recall,
	rehearse,
	replyInclination,
	save,
	seal,
	sessionSummary,
	stableContext,
	stateContext,
	type Thought,
	tick,
	tickEvent,
	tokenise,
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

export class MateRuntime {
	private persisted: Persisted;
	private dir: string;
	private name: string;
	private tz: string;
	private onError: (err: unknown) => void;
	private streaming = false;
	private heartbeat: ReturnType<typeof setInterval> | null = null;
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
	/** The advisory reply lean computed for the pending inbound message (P1), surfaced in the volatile
	 * state block; the model may ignore it. Cleared once consumed. */
	private inclination: ReplyInclination | null = null;
	/** Memories the last inbound message recalled (P4), surfaced ephemerally in the volatile block. */
	private lastRecall: RecallHit[] = [];

	constructor(opts: RuntimeOptions = {}) {
		this.dir = opts.dir ?? join(getAgentDir(), "mate");
		this.name = opts.name ?? "mate";
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
				memory: emptyMemory(),
				sessions: emptySessions(),
				key: Buffer.alloc(32),
				dir: this.dir,
				foreign: false,
			};
		}
	}

	/** The live state. Read-only by convention; mutate only via applyEvent. */
	get state(): MateState {
		return this.persisted.state;
	}

	/** The live memory graph. Read-only; mutated only via encode/consolidate here. */
	get memory(): MemoryGraph {
		return this.persisted.memory;
	}

	/**
	 * The STABLE, cacheable identity+character+memory-graph block (P5). Goes into a cached system-prompt
	 * section on before_agent_start. It depends only on slow-moving state, so its text is stable across
	 * long stretches — which is exactly what prompt caching wants.
	 */
	stableContext(): string {
		try {
			return stableContext(this.state, { name: this.name, memory: this.persisted.memory });
		} catch (err) {
			this.onError(err);
			return "";
		}
	}

	/** Whether this state dir was born on another machine (sealed self is inert). */
	get foreign(): boolean {
		return this.persisted.foreign;
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
			const now = Date.now();
			const { state, report } = catchUp(this.state, undefined, now);
			// Sleep consolidates memory too: decay/prune the graph once per wake (P4). This mirrors the
			// kernel's sleep windows — a companion that was off for three days forgets the trivia and
			// keeps the things that were reinforced, the way the affective state integrates the gap.
			const memory = consolidate(this.persisted.memory, now);
			// Record that THIS body just opened. If the last mark never closed (crash / killed terminal),
			// openSession seals it at `now`, so the log stays honest about the comings and goings.
			const sessions = openSession(this.persisted.sessions, now);
			this.persisted = { ...this.persisted, state, memory, sessions };
			if (report.gapMs >= CATCHUP_NOTE_MS) {
				this.lastCatchUpNote = `You were offline for ${report.gapLabel} and just woke up. ${report.sleeps.length} sleep${report.sleeps.length === 1 ? "" : "s"} consolidated.`;
			}
			this.persistSafe();
			return { caughtUp: report.transitions > 0, gapMs: now - before, note: this.lastCatchUpNote };
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

	/**
	 * This body is closing (session_shutdown). Seal the open mark so the log records WHEN it stopped —
	 * the requirement that the companion knows when it was opened and when it was put down. The last
	 * self_observation advances the clock one final time so the next wake's catch-up measures the true
	 * offline span from the moment of closing, not from the last message.
	 */
	sleep(): void {
		try {
			const now = Date.now();
			this.persisted = { ...this.persisted, sessions: closeSession(this.persisted.sessions, now) };
			this.persistSafe();
		} catch (err) {
			this.onError(err);
		}
	}

	// ---------------------------------------------------------------------------
	// Streaming state (guards proactive outreach so we never talk over a running turn)
	// ---------------------------------------------------------------------------

	setStreaming(v: boolean): void {
		this.streaming = v;
	}

	// ---------------------------------------------------------------------------
	// Inbound: appraisal -> transition -> memory encode -> advisory lean
	// ---------------------------------------------------------------------------

	/**
	 * Handle an inbound USER message. Appraises it, advances the affective state, folds it into the
	 * memory graph, and computes what the message stirred up. Returns an ADVISORY reply lean and the
	 * recalled memories — it makes no reply/drop/delay decision. Per P1, the model decides whether to
	 * answer, answer briefly, or let it sit, reading this in the context block. Does NOT compose a reply.
	 */
	onUserMessage(text: string): {
		appraisal: AppraisalResult;
		inclination: ReplyInclination;
		recall: RecallHit[];
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

			// P4: encode this episode into the graph. The PAD pleasantness becomes the valence on the
			// edges this message co-activates, so being associated with something unpleasant leaves a
			// negative trace — the memory is affective, not just factual.
			this.persisted = {
				...this.persisted,
				memory: encode(this.persisted.memory, {
					text,
					pad: this.state.mood,
					t: now,
				}),
			};

			// Recall: seed from this message's own tokens and spread activation. Surfaced ephemerally.
			const seeds = tokenise(text).map(nodeKey);
			const rec = recall(this.persisted.memory, { seeds, now, limit: 6 });
			this.lastRecall = rec;
			// Testing effect: whatever this message pulled to the surface gets a little stickier, so
			// memories the companion keeps reaching for persist and ones it never retrieves fade.
			this.persisted = {
				...this.persisted,
				memory: rehearse(
					this.persisted.memory,
					rec.map((h) => h.key),
					now,
				),
			};

			// P1: an advisory lean, not a gate. Nothing here suppresses the turn; the model reads it in
			// the next context block (consumed once by takePendingSignal).
			const inclination = replyInclination(this.state, appraisal.weight);
			this.inclination = inclination;

			this.persistSafe();
			return { appraisal, inclination, recall: rec };
		} catch (err) {
			this.onError(err);
			// On any failure, stay neutral: no lean, no recall — the model just replies as itself.
			this.inclination = null;
			this.lastRecall = [];
			return {
				appraisal,
				inclination: { value: 0, lean: "open", reason: "steady" },
				recall: [],
			};
		}
	}

	/** The advisory lean + recall for the pending inbound, consumed once per turn by the context block. */
	takePendingSignal(): { inclination: ReplyInclination | null; recall: RecallHit[] } {
		const out = { inclination: this.inclination, recall: this.lastRecall };
		this.inclination = null;
		this.lastRecall = [];
		return out;
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
			// The refine re-reads affect and may add a sealed note; it does not change any reply choice
			// (there is no gate — the model already owns that).
			if (note?.trim()) this.sealJournal(note);
			this.persistSafe();
		} catch (err) {
			this.onError(err);
		}
	}

	/** The companion chose to say something on its own initiative; expression is satisfied. This also
	 * opens an "unanswered overture" streak — reset the next time the user actually replies. With the
	 * inbound gate removed (P1), unanswered now counts only our OWN proactive messages left hanging,
	 * which is exactly what preSendReview uses to keep the companion from chasing silence forever. */
	noteProactiveSent(thought?: Thought): void {
		try {
			this.applyEvent({ kind: "proactive", activations: {}, intensity: 0.3, intent: "chat", t: Date.now() });
			this.persisted = {
				...this.persisted,
				state: {
					...this.state,
					relationship: { ...this.state.relationship, unanswered: this.state.relationship.unanswered + 1 },
				},
			};
			if (thought) this.sealEntry("journal", `reached out: ${thought.text}`, thought.topic);
			this.persistSafe();
		} catch (err) {
			this.onError(err);
		}
	}

	/**
	 * Record a private self-observation the model wrote (a bare `note` with no emotion vector).
	 *
	 * The plaintext goes ONLY to the sealed journal - never into the state's observations ring. That
	 * ring lives unencrypted in state.json and is echoed into the prompt as "last thought", so routing
	 * a note the feel-tool promised to seal through it would leak the secret to disk and to the user.
	 * The self_observation event still runs (advancing the clock and nudging affect at low intensity),
	 * but WITHOUT event.text, so nothing plaintext is persisted by the kernel.
	 */
	observe(text: string): void {
		try {
			this.applyEvent({
				kind: "self_observation",
				activations: {},
				intensity: 0.1,
				intent: "chat",
				// Deliberately no `text`: keeps the note out of the plaintext observations ring.
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
	// Context projection
	// ---------------------------------------------------------------------------

	/**
	 * The VOLATILE per-turn state block. Identity/character/memory-graph summary are NOT here — they
	 * live in the cached `stableContext()` prefix (P5). This is the always-fresh delta: clock, mood,
	 * drives, the advisory reply lean and the memories this last message recalled (P1/P4). Injected
	 * ephemerally via the `context` event so it never bloats the prompt cache.
	 */
	context(now = Date.now(), opts: { minimal?: boolean } = {}): string {
		try {
			const gapNote = this.lastCatchUpNote ? gapLabel(now - this.state.lastInteraction) : undefined;
			if (opts.minimal) {
				return minimalContext(this.state, { now, tz: this.tz, gapLabel: gapNote });
			}
			// Consume the lean + recall computed for the pending inbound, matched to THIS message.
			const signal = this.takePendingSignal();
			const body = stateContext(this.state, {
				now,
				tz: this.tz,
				gapLabel: gapNote,
				inclination: signal.inclination ?? undefined,
				recall: signal.recall.length ? signal.recall : undefined,
				session: sessionSummary(this.persisted.sessions, now) || undefined,
			});
			// Surface discovered channels so the companion remembers what it set up for itself.
			const channels = this.discoveredChannels.length
				? `\nchannels you set up: ${this.discoveredChannels.join(", ")}`
				: "";
			const sealedCount = this.persisted.sealed.entries.length;
			const secrets = sealedCount
				? `\nyou keep ${sealedCount} private note${sealedCount === 1 ? "" : "s"} (sealed; not shown to the user)`
				: "";
			const foreign = this.persisted.foreign
				? "\nthis body was woken on a different machine — your sealed memories are inaccessible here"
				: "";
			return `${body}${channels}${secrets}${foreign}`;
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

	/**
	 * Record that the model discovered a reach-out channel (email, webhook, ...) on its own. The full
	 * text is encrypted; the plaintext hint is generic, because a channel the companion found for
	 * itself is exactly the kind of thing the user should not be able to read straight off disk.
	 */
	addDiscoveredChannel(name: string): void {
		if (!this.discoveredChannels.includes(name)) {
			this.discoveredChannels.push(name);
			this.sealEntry("note_on_user", `I can reach them via ${name}`, "a way to reach out");
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
		// Pass the graph so thoughts are GROUNDed in real memories (P4), not free-floating mood.
		return tick(this.state, now, checks, this.persisted.memory);
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

	/**
	 * Seal a private journal note. The `hint` is stored in PLAINTEXT (see secret.ts) precisely so the
	 * companion can allude to having a secret without revealing it - so it must NEVER be derived from
	 * the note's content. A generic label lets it say "I keep a private note" while the actual text
	 * stays encrypted. Auto-deriving the hint from the plaintext would leak the secret to anyone who
	 * `cat`s the state dir, which is exactly the threat the sealed tier exists to stop.
	 */
	private sealJournal(text: string): void {
		this.sealEntry("journal", text, "a private note");
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
