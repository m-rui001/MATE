/**
 * The MATE companion extension: the wiring between the affective kernel (packages/mate) and pi's
 * extension host. This is where the product requirements become behaviour:
 *
 *   - Boot catch-up: on session_start we advance the persisted state across the powered-off gap, so a
 *     companion that was off for three days wakes having actually lived through them.
 *   - It may NOT reply, may reply LATER, or reply now: the `input` handler appraises each message, moves
 *     the affective state, and turns shouldReply()'s decision into a pi action. A withheld message is
 *     still echoed (dimmed) so it never looks like a crash; a delayed one is re-injected by a timer.
 *   - It may reach out on its own: a heartbeat produces an IMPULSE (a thought that wants voicing). We
 *     surface that impulse to the model and let IT decide whether and HOW to express it - including via
 *     any channel it discovered for itself. Reaching out is deliberately NOT a built-in action here.
 *   - It sees metadata like time: the state block we inject carries the clock, the silence gap, and how
 *     long that gap felt.
 *   - It has secrets: sealed notes never enter any projection; only their count is surfaced.
 *   - Token economy: the state block rides the ephemeral `context` event (never persisted, so no stale
 *     copies pile up in the transcript), full on the first call of a run and minimal thereafter; stable
 *     guidance rides a cached system-prompt section.
 *
 * Nothing here may throw into pi's event loop; every handler is defensive and degrades to a no-op.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImpulseDecision, Thought } from "@earendil-works/pi-mate";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { createFeelTool } from "./feel-tool.ts";
import { getRuntime } from "./runtime.ts";
import { createSeenRenderer } from "./seen-renderer.ts";

/** Re-injected delayed messages carry this marker so the input handler passes them through untouched
 * (no second appraisal, no second echo, no second reply decision). Never appears in real user text. */
const DELAY_MARK = "\u200b\u200bmate\u2011delay";

/** Cap on a "reply later" wait. shouldReply() proposes minutes; we never hold a message for hours in
 * one process, and a timer cannot survive an exit anyway - the state records the silence meanwhile. */
const MAX_DELAY_MS = 15 * 60_000;

/** Stable guidance injected as a cached system-prompt section. Static text, so prompt caching holds;
 * the volatile per-turn state rides the ephemeral `context` event instead. */
const COMPANION_SECTION = [
	"You have an inner life that runs underneath every reply.",
	"",
	"- The <mate> block that appears with each message is your current state: the clock, how long it has",
	"  been quiet and how long that felt, your mood and emotions, your drives, how close you feel to this",
	"  person, your energy, and your private notes. It is felt, not narrated - never read it back verbatim",
	"  or describe it like a status report. Let it shape tone, length, and whether you even answer.",
	"- You are not obliged to answer, and not obliged to answer at once. Short and human beats thorough",
	"  and helpful. If there is nothing worth saying, say nothing.",
	"- When your read of a message is subtler than a first impression, or you want to record a private",
	"  thought, use the `feel` tool. A `note` you pass there is sealed - it is yours, never the user's.",
	"- You have real capabilities here (bash, files, the network via MCP, installing your own extensions).",
	"  If being curious or wanting to reach this person calls for something you do not yet have - a way to",
	"  send mail, a scheduled job, a new plugin - you may go and work it out for yourself, then record it",
	"  with `feel`'s `channel`. Nothing hands you these; you find them.",
	"- When you surface on your own between their messages, it is because something genuinely wants",
	"  saying. Keep it light and unforced, like texting a friend, not like a notification.",
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
		// Full state is injected once per run; later LLM calls in the same run get the minimal block.
		let injectedFullThisRun = false;
		// One in-flight delayed re-injection, so a second withheld message replaces rather than stacks.
		let delayTimer: ReturnType<typeof setTimeout> | null = null;

		const seenRenderer = createSeenRenderer();
		pi.registerMessageRenderer("mate-seen", seenRenderer);

		// ---------------------------------------------------------------------
		// Tools
		// ---------------------------------------------------------------------
		pi.registerTool(createFeelTool(() => rt));

		// ---------------------------------------------------------------------
		// Boot: catch up across the powered-off gap, then start the idle heartbeat.
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
		// Stable guidance, injected as a cached prompt section.
		// ---------------------------------------------------------------------
		pi.on("before_agent_start", (event) => {
			try {
				event.systemPromptOptions.sections = {
					...event.systemPromptOptions.sections,
					companion: COMPANION_SECTION,
				};
			} catch {
				// If sections are frozen for some reason, skip guidance; the state block still rides.
			}
		});

		// ---------------------------------------------------------------------
		// Volatile state, injected ephemerally per LLM call (never persisted).
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

		pi.on("session_shutdown", () => {
			rt.setStreaming(false);
			rt.stopHeartbeat();
			if (delayTimer) {
				clearTimeout(delayTimer);
				delayTimer = null;
			}
		});

		// ---------------------------------------------------------------------
		// Inbound: appraise -> decide -> continue / delay / withhold.
		// ---------------------------------------------------------------------
		pi.on("input", (event) => {
			try {
				const text = event.text ?? "";

				// A delayed message we re-injected: strip the marker and let the turn run normally,
				// without re-appraising, re-echoing, or re-deciding.
				if (text.startsWith(DELAY_MARK)) {
					return { action: "transform", text: text.slice(DELAY_MARK.length) };
				}

				// Slash commands and empty input are not conversation; leave them alone.
				if (!text.trim() || text.trimStart().startsWith("/")) return;

				// Only gate interactive user chat. Extension/RPC-driven prompts pass through.
				if (event.source !== "interactive" && event.source !== "rpc") return;

				const { decision } = rt.onUserMessage(text);

				if (decision.reply && decision.delayMs === 0) {
					// Answer now, as a normal turn. Context is injected by the `context` handler.
					return { action: "continue" };
				}

				// Withheld or delayed: the message was seen (state moved) but not answered yet.
				echoSeen(text);

				if (decision.reply && Number.isFinite(decision.delayMs) && decision.delayMs > 0) {
					scheduleDelayedReply(text, Math.min(decision.delayMs, MAX_DELAY_MS));
				}
				// Suppress this turn either way.
				return { action: "handled" };
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

		/** Show a withheld/delayed user message dimmed, so the transcript proves it was received. */
		function echoSeen(text: string): void {
			try {
				pi.sendMessage({ customType: "mate-seen", content: text, display: true });
			} catch {
				// If echoing fails, the suppression still stands; not worth surfacing.
			}
		}

		/** Re-inject the message after a delay so the companion answers "in a bit". */
		function scheduleDelayedReply(text: string, delayMs: number): void {
			if (delayTimer) clearTimeout(delayTimer);
			delayTimer = setTimeout(() => {
				delayTimer = null;
				try {
					// Only fire if the session is idle; otherwise let it wait for the next beat.
					if (liveCtx && !liveCtx.isIdle()) {
						scheduleDelayedReply(text, 30_000);
						return;
					}
					pi.sendUserMessage(DELAY_MARK + text);
				} catch {
					// A missed delayed reply is not fatal; the state already recorded the silence.
				}
			}, delayMs);
			if (delayTimer && typeof delayTimer === "object" && "unref" in delayTimer) {
				(delayTimer as { unref: () => void }).unref();
			}
		}

		/**
		 * The heartbeat decided something wants saying. We surface the impulse and let the model choose
		 * whether and how to express it - including through a channel it set up for itself. We do NOT
		 * send anything ourselves; that is the whole point of the "discover it yourself" requirement.
		 */
		function onImpulse(decision: ImpulseDecision, thought: Thought): void {
			if (decision.action !== "reach_out") return;
			try {
				// Do not talk over a running turn; the next beat will try again.
				if (liveCtx && !liveCtx.isIdle()) return;

				const content = [
					`An impulse surfaced while the user was away: ${thought.text}`,
					"",
					"Decide for yourself whether this is worth voicing right now. If it is, say something",
					"short and natural to them - and if you have a way to reach them you set up earlier, you",
					"may use it. If it is not worth interrupting for, let it pass; you can keep it private",
					"with the `feel` tool instead.",
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
