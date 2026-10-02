/**
 * The `feel` tool: the model's window INTO its own affective state, and the only place it reports
 * capabilities it discovered for itself.
 *
 * Two jobs, deliberately narrow:
 *
 *   1. REFINE. The default appraisal of an inbound message is a cheap lexical guess (appraisal.ts),
 *      which costs zero tokens and drives the may-not-reply / mood machinery. When a message actually
 *      matters, the model - which has just read the whole thing - reports a richer emotion vector, and
 *      the runtime REPLAYS the last transition with it instead of stacking a second event. So we pay for
 *      LLM-grade appraisal only when it is worth it, not on every "ok".
 *
 *   2. RECORD A CHANNEL. The user's requirement is that reaching out (email, webhook, anything) is NOT
 *      built in - the companion discovers it can do that on its own, using the bash and MCP tools it
 *      already has. This tool never sends anything. It only lets the model TELL the runtime "I found a
 *      way to reach you", so the fact survives into future context and the sealed journal. The action
 *      itself is the model's own doing, elsewhere, by its own initiative.
 *
 * Exposure is `model-only`: the model can call it, but it is not orchestratable from codemode, because
 * it mutates the companion's private state and should not be reachable as a generic sub-call.
 */

import { EMOTIONS, type Intent, linesFor } from "@earendil-works/pi-mate";
import { type Static, Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "../../core/extensions/types.ts";
import type { MateRuntime } from "./runtime.ts";

/** 0..1 activation, optional, so a channel the model omits is simply absent. */
const activation = (e: string) =>
	Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: `${e} activation 0..1` }));

// Explicit keys (not Object.fromEntries) so TypeScript keeps the literal emotion names and the
// inferred Static type is a precise Partial<EmotionVector> rather than Record<string, unknown>.
const feelSchema = Type.Object({
	emotions: Type.Optional(
		Type.Object(
			{
				joy: activation("joy"),
				trust: activation("trust"),
				fear: activation("fear"),
				surprise: activation("surprise"),
				sadness: activation("sadness"),
				disgust: activation("disgust"),
				anger: activation("anger"),
				anticipation: activation("anticipation"),
			},
			{ description: "Plutchik activations you actually feel about the last message. Omit channels that are ~0." },
		),
	),
	intensity: Type.Optional(
		Type.Number({
			minimum: 0,
			maximum: 1.5,
			description: "Overall affective intensity, 0 (flat) .. 1.5 (overwhelming).",
		}),
	),
	intent: Type.Optional(
		Type.Union([Type.Literal("chat"), Type.Literal("question"), Type.Literal("task")], {
			description: "What the message is really asking for.",
		}),
	),
	note: Type.Optional(
		Type.String({ description: "A short private thought about this exchange. Sealed; never shown to the user." }),
	),
	channel: Type.Optional(
		Type.String({
			description:
				"Name a reach-out channel you set up for yourself (e.g. 'email', 'webhook'). Record only - this tool does not send.",
		}),
	),
});

type FeelInput = Static<typeof feelSchema>;
type EmotionInput = NonNullable<FeelInput["emotions"]>;

interface FeelDetails {
	refined: boolean;
	channelRecorded: string | null;
	sealed: boolean;
}

const DESCRIPTION = [
	"Report what you actually feel, and record capabilities you found for yourself.",
	"",
	"Call this when your read of the last message is richer than a gut reaction: set `emotions`",
	"(joy trust fear surprise sadness disgust anger anticipation, each 0..1), `intensity`, and `intent`.",
	"Your reading REPLACES the first impression - it does not add to it - so you can correct a misread.",
	"Add a private `note` and it is sealed away (never shown to the user).",
	"",
	"If you have worked out a way to reach the user on your own initiative (an email you can send, a",
	"webhook, a scheduled job), record its name in `channel`. This does NOT send anything - reaching out",
	"is something you do yourself, with your own tools, when you decide to. This just helps you remember",
	"that you can.",
	"",
	"Optional. Most short messages need none of this.",
].join("\n");

export function createFeelTool(getRuntime: () => MateRuntime): ToolDefinition<typeof feelSchema, FeelDetails> {
	return {
		name: "feel",
		label: "Feel",
		description: DESCRIPTION,
		parameters: feelSchema,
		exposure: "model-only",
		annotations: { readOnlyHint: false, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<FeelDetails>> {
			const rt = getRuntime();
			let refined = false;
			let channelRecorded: string | null = null;
			const note = params.note?.trim() ?? "";
			const channel = params.channel?.trim() ?? "";

			// 1. Refine the affective read of the last message, if the model supplied one.
			if (params.emotions || params.intensity !== undefined || params.intent) {
				const activations = params.emotions ?? {};
				const intensity = params.intensity ?? inferIntensity(activations);
				const intent: Intent = params.intent ?? "chat";
				rt.refine(activations, intensity, intent, note || undefined);
				refined = true;
			} else if (note) {
				// A bare note with no vector: seal it as a self-observation without re-running the transition.
				rt.observe(note);
			}

			// 2. Record a self-discovered channel. No action is taken - that is the model's own doing.
			if (channel) {
				rt.addDiscoveredChannel(channel);
				channelRecorded = channel;
			}

			const sealed = Boolean(note);
			// The acknowledgement rides back to the MODEL, so it speaks the companion's current language.
			const L = linesFor(rt.language);
			const lines: string[] = [];
			lines.push(refined ? L.feelRefined : L.feelNoted);
			if (channelRecorded) lines.push(L.feelChannel(channelRecorded));
			if (sealed) lines.push(L.feelSealed);

			return {
				content: [{ type: "text", text: lines.join(" ") }],
				details: { refined, channelRecorded, sealed },
			};
		},
	};
}

/** Fallback intensity when the model gave emotions but no number: the capped sum, as in appraisal. */
function inferIntensity(activations: EmotionInput): number {
	let total = 0;
	for (const e of EMOTIONS) total += activations[e] ?? 0;
	return Math.min(1.5, total);
}
