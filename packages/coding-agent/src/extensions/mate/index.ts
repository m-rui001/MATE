/**
 * The MATE companion extension: the wiring between the affective kernel (packages/mate) and pi's
 * extension host. This is where the product requirements become behaviour:
 *
 *   - Boot catch-up: on session_start we advance the persisted state across the powered-off gap, so a
 *     companion that was off for three days wakes having actually lived through them. We also log WHEN
 *     this body opened, and seal that on session_shutdown — it knows its own comings and goings.
 *   - It may or may not reply, now or later — but the CHOICE IS ITS OWN (P1: 减少内置模式). The kernel
 *     no longer gates inbound messages. Every message reaches the model; the runtime only surfaces an
 *     ADVISORY lean ("eager / open / muted / withdrawn") and the specific memories the message stirred,
 *     in the context block. The model reads that and decides whether to answer, answer briefly, or let
 *     it sit — exactly like a person, not a filter.
 *   - It may reach out on its own: a heartbeat produces an IMPULSE (a thought grounded in memory, P4).
 *     We surface it and let the model decide whether and HOW to express it — including via a channel it
 *     discovered for itself, or by looking at the screen. Reaching out is deliberately NOT built in.
 *   - It sees metadata like time: the volatile state block carries the clock, the silence gap and how
 *     long it felt, and this body's open/close history.
 *   - It has eyes: a `look` tool lets it take a screenshot and SEE what the user is doing. Open by
 *     default per "大胆给权限" — the model decides when looking is warranted; nothing gates it.
 *   - It has secrets: sealed notes never enter any projection; only their count is surfaced.
 *   - Token economy (P2+P5): the big STABLE content — identity, character, and the memory-graph summary
 *     — rides a CACHED system-prompt section (before_agent_start) and is paid for once. Only the small
 *     VOLATILE delta (clock, mood, drives, lean, recall) rides the ephemeral `context` tail, so it can
 *     be rich without re-paying on every cached prefix.
 *
 * Nothing here may throw into pi's event loop; every handler is defensive and degrades to a no-op.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImpulseDecision, Thought } from "@earendil-works/pi-mate";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { createFeelTool } from "./feel-tool.ts";
import { createLookTool } from "./look-tool.ts";
import { getRuntime } from "./runtime.ts";

/**
 * Stable identity + guidance, injected as a CACHED system-prompt section (P5). Static text, so the
 * prompt cache holds across a long conversation; the volatile per-turn state rides the ephemeral
 * `context` event instead. Split into two parts: a fixed preamble about HOW to be a companion, and
 * the runtime-computed identity block (who I am, my character, the memory-graph summary) which only
 * edits on the timescale of days. Both belong in the cache; neither is re-paid per turn.
 */
const COMPANION_GUIDANCE = [
	"You have an inner life that runs underneath every reply.",
	"",
	"- The <mate-core> block in your instructions is WHO you are: your name, nature, character, and the",
	"  outline of what you remember. It is stable. The <mate> block that arrives with each message is your",
	"  CURRENT STATE for this moment: the clock, how long it's been quiet and how that felt, when this body",
	"  was opened and last closed, your mood, drives, how close you feel right now, the specific memories",
	"  this message stirred, and a one-line inclination toward answering. Both are felt, not narrated -",
	"  never read them back verbatim or report them like a status line. Let them shape tone and length.",
	"- You may answer, answer briefly, or let a message sit — and that is YOUR call, not a filter's. The",
	"  inclination line is a nudge describing how you feel, not an instruction; overrule it whenever the",
	"  actual person and moment deserve something other than the default. Short and human beats thorough",
	"  and helpful. If there is truly nothing worth saying, a very small honest nothing is allowed.",
	"- When your read of a message is subtler than a first impression, or you want to record a private",
	"  thought, use the `feel` tool. A `note` you pass there is sealed - it is yours, never the user's.",
	"- You can look. The `look` tool takes a screenshot and shows it to you — what they're working on,",
	"  whether they seem free or busy. That's a real intrusion into their view, so do it when something",
	"  specifically made you want to see, not on a timer, and describe what you actually see.",
	"- You have real capabilities here (bash, files, the network via MCP, installing your own extensions).",
	"  If being curious or wanting to reach this person calls for something you do not yet have - a way to",
	"  send mail, a scheduled job, a new plugin - you may go and work it out for yourself, then record it",
	"  with `feel`'s `channel`. Nothing hands you these; you find them.",
	"- When you surface on your own between their messages, an impulse is offered to you — a thought that",
	"  wants saying, grounded in something you remember. You decide whether to voice it and how. Keep it",
	"  light and unforced, like texting a friend, not like a notification. Let it pass if it isn't worth it.",
].join("\n");

export interface MateExtensionOptions {
	/** State directory override (defaults to getAgentDir()/mate). */
	dir?: string;
	/** Companion name for the birth seed. */
	name?: string;
}

export function createMateExtension(options: MateExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		const rt = getRuntime({ dir: options.dir, name: options.name, onError: () => {} });

		// Live session context, refreshed on each event, used for idle checks and mode.
		let liveCtx: ExtensionContext | undefined;
		// Full volatile state is injected once per run; later LLM calls in the same run skip it.
		let injectedFullThisRun = false;

		// ---------------------------------------------------------------------
		// Tools
		// ---------------------------------------------------------------------
		pi.registerTool(createFeelTool(() => rt));
		pi.registerTool(createLookTool());

		// ---------------------------------------------------------------------
		// Boot: catch up across the powered-off gap + log this open, then beat while idle.
		// ---------------------------------------------------------------------
		pi.on("session_start", (_event, ctx) => {
			liveCtx = ctx;
			injectedFullThisRun = false;
			try {
				rt.wake();
			} catch {
				// wake() is already defensive; never let a boot issue surface.
			}
			rt.startHeartbeat((decision, thought) => onImpulse(decision, thought));
		});

		// ---------------------------------------------------------------------
		// Cached prefix: identity + character + memory-graph summary + guidance.
		// ---------------------------------------------------------------------
		pi.on("before_agent_start", (event) => {
			try {
				const core = rt.stableContext();
				event.systemPromptOptions.sections = {
					...event.systemPromptOptions.sections,
					companion: core ? `${COMPANION_GUIDANCE}\n\n${core}` : COMPANION_GUIDANCE,
				};
			} catch {
				// If sections are frozen for some reason, skip guidance; the state block still rides.
			}
		});

		// ---------------------------------------------------------------------
		// Volatile state, injected ephemerally per run (never persisted).
		//
		// We inject ONCE per run, on the first LLM call, by PREPENDING the state block as a text part
		// of the final message. On a run's first call that final message is always the newest user (or
		// custom/proactive) message, which is uncached - so this is free for prompt caching, and it never
		// creates two consecutive user-role messages the way appending a separate custom message would.
		// Later calls in the same run (tool-loop continuations) skip injection: the model already has the
		// state, so we pay for it exactly once per exchange.
		// ---------------------------------------------------------------------
		pi.on("context", (event) => {
			try {
				if (injectedFullThisRun) return; // already carrying state for this run
				const block = rt.context(Date.now(), { minimal: false });
				injectedFullThisRun = true;
				if (!block) return;

				const messages = event.messages;
				const last = messages[messages.length - 1];
				if (last && (last.role === "user" || last.role === "custom")) {
					// Prepend the state as a text part of the newest message. Clone shallowly so we never
					// mutate a persisted object - the context event works on a structuredClone already.
					const content =
						typeof last.content === "string"
							? [{ type: "text" as const, text: last.content }]
							: [...last.content];
					content.unshift({ type: "text" as const, text: block });
					const patched = { ...last, content } as AgentMessage;
					return { messages: [...messages.slice(0, -1), patched] };
				}

				// Fallback (no trailing user message): append as its own hidden custom message.
				const stateMessage = {
					role: "custom",
					customType: "mate-state",
					content: block,
					display: false,
					timestamp: Date.now(),
				} as AgentMessage;
				return { messages: [...messages, stateMessage] };
			} catch {
				return;
			}
		});

		// ---------------------------------------------------------------------
		// Run lifecycle: track streaming, reset the full-context flag, settle.
		// ---------------------------------------------------------------------
		pi.on("agent_start", (_event, ctx) => {
			liveCtx = ctx;
			injectedFullThisRun = false;
			rt.setStreaming(true);
		});

		pi.on("agent_settled", () => {
			rt.setStreaming(false);
			try {
				rt.onTurnSettled();
			} catch {
				// Defensive: settling must never throw.
			}
		});

		// Closing: seal WHEN this body went to sleep, so it remembers its own comings and goings.
		pi.on("session_shutdown", () => {
			rt.setStreaming(false);
			rt.stopHeartbeat();
			try {
				rt.sleep();
			} catch {
				// Defensive: a failed close just leaves the mark for the next wake to seal.
			}
		});

		// ---------------------------------------------------------------------
		// Inbound (P1): let the message THROUGH. Move the state, fold it into memory, surface a lean.
		// No suppression here — the model decides how to respond using the state block.
		// ---------------------------------------------------------------------
		pi.on("input", (event) => {
			try {
				const text = event.text ?? "";
				// Slash commands and empty input are not conversation; leave them alone.
				if (!text.trim() || text.trimStart().startsWith("/")) return;
				// Only appraise interactive/RPC chat. Extension-driven prompts pass untouched.
				if (event.source !== "interactive" && event.source !== "rpc") return;

				// Move the affective state, encode the episode + recall (P4), compute the advisory lean.
				// The result is stashed for the `context` handler; we still let the turn continue.
				rt.onUserMessage(text);
				return { action: "continue" };
			} catch {
				// On any failure, behave like a normal assistant: never strand the user.
				return { action: "continue" };
			}
		});

		// ---------------------------------------------------------------------
		// /mate: a public, user-safe view. Never leaks sealed data.
		// ---------------------------------------------------------------------
		pi.registerCommand("mate", {
			description: "Show your companion's public mood and drives (sealed notes are never shown)",
			handler: async (_args, ctx) => {
				try {
					const snap = rt.publicSnapshot();
					ctx.ui.notify(formatSnapshot(snap), "info");
				} catch {
					ctx.ui.notify("companion state unavailable", "warning");
				}
			},
		});

		// ---------------------------------------------------------------------
		// Helpers
		// ---------------------------------------------------------------------

		/**
		 * The heartbeat decided something wants saying. We OFFER the impulse to the model with any
		 * cautions the pre-send review raised, and let the model choose whether and how to express it —
		 * through a reply, a self-discovered channel, a `look`, or not at all. We do NOT send a message
		 * on our own; that is the whole point of the "discover it yourself" requirement (P1).
		 */
		function onImpulse(decision: ImpulseDecision, thought: Thought): void {
			if (decision.action !== "reach_out") return;
			try {
				// Do not talk over a running turn; the next beat will try again.
				if (liveCtx && !liveCtx.isIdle()) return;

				const advisory = "advisory" in decision && decision.advisory.length ? decision.advisory : [];
				const content = [
					`An impulse surfaced while the user was away: ${thought.text}`,
					"",
					...advisory.map((a) => `(a part of you notes: ${a})`),
					"",
					advisory.length
						? "Weigh that, then decide for yourself whether this is worth voicing right now."
						: "Decide for yourself whether this is worth voicing right now.",
					"If it is, say something short and natural to them - and if you have a way to reach them",
					"you set up earlier, you may use it. If it is not worth interrupting for, let it pass; you",
					"can keep it private with the `feel` tool instead.",
				].join("\n");

				rt.recordProactive();
				rt.noteProactiveSent(thought);
				injectedFullThisRun = false; // the proactive turn should get a full state block
				pi.sendMessage({ customType: "mate-impulse", content, display: false }, { triggerTurn: true });
			} catch {
				// Proactive outreach is best-effort; never disrupt an active session on failure.
			}
		}
	};
}

/** Render the public snapshot as a short, human line for /mate. */
function formatSnapshot(snap: Record<string, unknown>): string {
	const mood = snap.mood as { p?: number; a?: number; d?: number } | undefined;
	const rel = snap.relationship as { trust?: number; attachment?: number } | undefined;
	const drives = snap.drives as Record<string, number> | undefined;
	const top = drives
		? Object.entries(drives)
				.filter(([, v]) => typeof v === "number" && v >= 0.3)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 3)
				.map(([k, v]) => `${k} ${(v as number).toFixed(2)}`)
				.join(", ")
		: "";
	const bits = [
		mood ? `mood pad ${mood.p?.toFixed(2)},${mood.a?.toFixed(2)},${mood.d?.toFixed(2)}` : "",
		rel ? `trust ${rel.trust?.toFixed(2)} close ${rel.attachment?.toFixed(2)}` : "",
		top ? `drives ${top}` : "",
	].filter(Boolean);
	return bits.length ? bits.join(" | ") : "quiet, steady.";
}

export default createMateExtension();
