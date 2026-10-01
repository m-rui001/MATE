/**
 * Renderer for the `mate-seen` custom message: a withheld or delayed user message, echoed back dimmed
 * so the transcript proves it landed even though the companion chose not to answer (yet). Without this,
 * pi's `input` "handled" path would drop the message entirely and it would look like a crash or a keypress
 * that did nothing.
 *
 * It renders the user's own text in the dim foreground, plus a one-word marker so the silence reads as a
 * choice rather than a failure. It never shows any affective internals - this is user-facing.
 */

import type { Component } from "@earendil-works/pi-tui";
import { Container, Text } from "@earendil-works/pi-tui";
import type { MessageRenderer, MessageRenderOptions } from "../../core/extensions/types.ts";
import type { CustomMessage } from "../../core/messages.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

export function createSeenRenderer(): MessageRenderer<unknown> {
	return (message: CustomMessage<unknown>, _options: MessageRenderOptions, theme: Theme): Component | undefined => {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");

		const container = new Container();
		container.addChild(new Text(theme.fg("dim", text), 1, 0));
		container.addChild(new Text(theme.fg("dim", "· seen, not answered"), 1, 0));
		return container;
	};
}
