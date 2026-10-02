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
 *   - It THINKS in the language you pick. `/language` (or the first-run picker) sets the companion's
 *     render language, persisted in the state dir, and every prompt-visible surface — the cached
 *     guidance, the projections, the kernel's thoughts, impulses, advisories — is authored in it (see
 *     packages/mate/src/i18n.ts for why a Chinese prompt, not an English one plus "please think in
 *     Chinese", is what actually holds). Switching costs one prompt-cache miss, then holds again.
 *
 * Nothing here may throw into pi's event loop; every handler is defensive and degrades to a no-op.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	companionSection,
	driveGloss,
	type ImpulseDecision,
	LANG_NAMES,
	type Lang,
	linesFor,
	type Thought,
} from "@earendil-works/pi-mate";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { createFeelTool } from "./feel-tool.ts";
import { createLookTool } from "./look-tool.ts";
import { getRuntime } from "./runtime.ts";

/**
 * Parse a `/language` argument. Only unambiguous tokens are accepted; anything else returns undefined
 * so the command can show the picker instead of silently switching to English on a typo.
 */
function parseLangArg(arg: string): Lang | undefined {
	const s = arg.trim().toLowerCase();
	if (!s) return undefined;
	if (s === "zh" || s === "cn" || s === "chinese" || s === "中文" || s === "汉语" || s.startsWith("zh-")) return "zh";
	if (s === "en" || s === "english" || s === "英文" || s === "英语" || s.startsWith("en-")) return "en";
	return undefined;
}

/** The picker options, in the language they mean: each row names itself in its own tongue. */
const LANG_CHOICES: Array<{ label: string; lang: Lang }> = [
	{ label: "中文 — 用中文思考和说话", lang: "zh" },
	{ label: "English — think and speak in English", lang: "en" },
];

/** The user-visible notice after a switch, in the language just chosen. */
function switchedNote(lang: Lang): string {
	return lang === "zh" ? "伴侣改用中文思考和说话。" : "Your companion now thinks and speaks in English.";
}

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
		// First run: ask which language this companion should think in, if the terminal can ask.
		// ---------------------------------------------------------------------
		pi.on("session_start", async (_event, ctx) => {
			liveCtx = ctx;
			injectedFullThisRun = false;
			try {
				rt.wake();
			} catch {
				// wake() is already defensive; never let a boot issue surface.
			}
			// Only when NOTHING was ever chosen — not on every English boot. Headless modes (json/print)
			// have no dialog; they keep the English default and the user can set /language later.
			if (!rt.languageChosen && ctx.hasUI) {
				try {
					const choice = await ctx.ui.select(
						"伴侣用什么语言思考？ / What language should your companion think in?",
						[...LANG_CHOICES.map((c) => c.label)],
					);
					const picked = LANG_CHOICES.find((c) => c.label === choice);
					// Escaping the dialog is a decision too: default to English so the picker never repeats.
					rt.setLanguage(picked?.lang ?? "en");
				} catch {
					// A failed dialog must not block boot.
				}
			}
			rt.startHeartbeat((decision, thought) => onImpulse(decision, thought));
		});

		// ---------------------------------------------------------------------
		// Cached prefix: identity + character + memory-graph summary + guidance.
		// ---------------------------------------------------------------------
		pi.on("before_agent_start", (event) => {
			try {
				const core = rt.stableContext();
				// companionSection() is guidance + the thinking-language declaration, in the chosen
				// language. English keeps the previous guidance wording verbatim; the new one-paragraph
				// declaration at its end is the only delta, so the first boot after upgrade takes one
				// cache miss, then holds. A language switch rewrites this whole section: one miss, then
				// holds again (P5).
				const guidance = companionSection(rt.language);
				event.systemPromptOptions.sections = {
					...event.systemPromptOptions.sections,
					companion: core ? `${guidance}\n\n${core}` : guidance,
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
					ctx.ui.notify(formatSnapshot(snap, rt.language), "info");
				} catch {
					ctx.ui.notify("companion state unavailable", "warning");
				}
			},
		});

		// ---------------------------------------------------------------------
		// /language: what language this companion thinks in. Persisted in the state dir, so it
		// survives power-off. No built-in /language exists, so there is no command collision; if a
		// third-party extension registers one too, pi renames ours (language:N), never the reverse.
		// ---------------------------------------------------------------------
		pi.registerCommand("language", {
			description: "Pick the language your companion thinks and speaks in (中文 / English)",
			handler: async (args, ctx) => {
				let next = parseLangArg(args ?? "");
				if (!next && ctx.hasUI) {
					const choice = await ctx.ui.select(
						"语言 / Language",
						LANG_CHOICES.map((c) => c.label),
					);
					next = LANG_CHOICES.find((c) => c.label === choice)?.lang;
				}
				if (!next) {
					// Headless with no argument: just report the current setting.
					ctx.ui.notify(`language: ${LANG_NAMES[rt.language]}  (/language zh | en)`, "info");
					return;
				}
				rt.setLanguage(next);
				ctx.ui.notify(switchedNote(next), "info");
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

				// The impulse is the companion's own inner voice, so it arrives in ITS language.
				const L = linesFor(rt.language);
				const advisory = "advisory" in decision && decision.advisory.length ? decision.advisory : [];
				const content = [
					L.impulseSurfaced(thought.text),
					"",
					...advisory.map((a) => L.impulseAdvisory(a)),
					"",
					advisory.length ? L.impulseWeigh : L.impulseDecide,
					L.impulseBody,
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

/** Render the public snapshot as a short, human line for /mate, in the companion's language. */
function formatSnapshot(snap: Record<string, unknown>, lang: Lang = "en"): string {
	const L = linesFor(lang);
	const mood = snap.mood as { p?: number; a?: number; d?: number } | undefined;
	const rel = snap.relationship as { trust?: number; attachment?: number } | undefined;
	const drives = snap.drives as Record<string, number> | undefined;
	const top = drives
		? Object.entries(drives)
				.filter(([, v]) => typeof v === "number" && v >= 0.3)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 3)
				.map(([k, v]) => `${driveGloss(k, lang)} ${(v as number).toFixed(2)}`)
				.join(lang === "zh" ? " " : ", ")
		: "";
	const bits = [
		mood ? L.snapMood(`${mood.p?.toFixed(2)},${mood.a?.toFixed(2)},${mood.d?.toFixed(2)}`) : "",
		rel ? `${L.snapTrust(rel.trust?.toFixed(2) ?? "")} ${L.snapClose(rel.attachment?.toFixed(2) ?? "")}` : "",
		top ? `${L.snapDrives} ${top}` : "",
	].filter(Boolean);
	return bits.length ? bits.join(" | ") : L.snapQuiet;
}

export default createMateExtension();
