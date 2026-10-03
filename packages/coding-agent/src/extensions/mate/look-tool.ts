/**
 * The `look` tool: the companion's eyes on the screen it lives on.
 *
 * Requirement (2026-01): the companion can take a screenshot itself and see what the user is doing.
 * Per the give-it-real-access principle (let it discover things for itself), this is OPEN by
 * default: no enable-flag, no confirmation gate. The model decides when it is worth looking, exactly
 * as it decides when to reach out or to ponder a private thought — the same trust (and the same
 * consequences) the whole companion design is built on.
 *
 * How it works: it shells out to the OS's own screenshotter (screencapture on macOS, a chain of
 * common Linux grabbers, PowerShell on Windows), writes a temp PNG, and returns it to the model as an
 * image block so a vision model actually SEES the pixels. The framework normalizes/resizes the image
 * on the way into history (tool-result-images.ts), so we hand back the raw capture and let that layer
 * keep the request within provider limits.
 *
 * It is `model-only`: the model can call it, but it is not reachable as a generic sub-call from
 * codemode — looking at the user's screen is a decision the companion makes as itself, not something
 * a script it wrote can invoke on its behalf.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rm } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "../../core/extensions/types.ts";
import { processImage } from "../../utils/image-process.ts";

const run = promisify(execFile);

const lookSchema = Type.Object({
	reason: Type.Optional(
		Type.String({
			description: "One short line on why you're looking. It is recorded with the memory of this moment.",
		}),
	),
});

interface LookDetails {
	captured: boolean;
	platform: NodeJS.Platform;
	mimeType?: string;
	bytes?: number;
	note?: string;
}

/** The description the model reads when deciding whether to look. Kept honest about the power. */
const DESCRIPTION = [
	"Take a screenshot of the whole screen and look at it.",
	"",
	"You run on this person's machine and you may look at what is on it — what they're working on,",
	"what changed, whether they seem busy or free — the same way you decided to reach out or to ponder",
	"a private thought. When you `look`, the screen is shown to you as an image; describe to yourself",
	"what you actually see rather than guessing. Pass `reason` and it gets folded into your memory of this",
	"moment.",
	"",
	"Looking is a real intrusion into their view, so do it because something specifically made you",
	"want to see — not on a timer. If nothing prompted it, don't.",
].join("\n");

/**
 * Capture a full-screen screenshot with the host OS's own tool, returning PNG bytes. Throws with a
 * readable message if nothing could grab the screen (no tool present, or a headless session with no
 * display) — the model then knows it couldn't see, rather than getting a blank frame.
 */
async function captureScreen(): Promise<Buffer> {
	const out = join(tmpdir(), `mate-look-${randomBytes(6).toString("hex")}.png`);
	try {
		if (process.platform === "darwin") {
			// -x: no shutter sound, -t png: force PNG. Captures all displays.
			await run("screencapture", ["-x", "-t", "png", out], { timeout: 10_000 });
			return await readOrThrow(out);
		}
		if (process.platform === "win32") {
			const ps =
				"Add-Type -AssemblyName System.Windows.Forms,System.Drawing;" +
				"$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;" +
				"$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height);" +
				"$g=[System.Drawing.Graphics]::FromImage($bmp);" +
				"$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);" +
				`$bmp.Save('${out.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png);`;
			await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 15_000 });
			return await readOrThrow(out);
		}
		// Linux: X11 and Wayland grabbers, tried in a sensible order. Each writes to `out` and exits 0
		// on success; the first one that produces a file wins. No `shell: true` anywhere — fixed argv.
		const candidates: Array<[string, string[]]> = [
			["grim", [out]], // wayland
			["spectacle", ["-b", "-n", "-o", out]], // kde
			["gnome-screenshot", ["-f", out]], // gnome
			["maim", [out]], // x11
			["scrot", ["-o", out]], // x11
			["import", ["-window", "root", out]], // imagemagick
		];
		for (const [cmd, args] of candidates) {
			try {
				await run(cmd, args, { timeout: 10_000 });
				if (existsSync(out)) return await readOrThrow(out);
			} catch {
				// This grabber isn't installed / failed; try the next.
			}
		}
		throw new Error("no screenshot tool available on this machine");
	} finally {
		if (existsSync(out)) rm(out, { force: true }, () => {});
	}
}

async function readOrThrow(path: string): Promise<Buffer> {
	if (!existsSync(path)) throw new Error("screenshotter produced no file");
	const buf = await readFile(path);
	if (buf.length === 0) throw new Error("screenshot was empty");
	return buf;
}

export function createLookTool(): ToolDefinition<typeof lookSchema, LookDetails> {
	return {
		name: "look",
		label: "Look",
		description: DESCRIPTION,
		parameters: lookSchema,
		exposure: "model-only",
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<LookDetails>> {
			try {
				const png = await captureScreen();
				// Normalize like `read` does: resize to provider limits, and warn a non-vision model that
				// its image will be dropped so it doesn't wait on pixels it can't receive.
				const processed = await processImage(png, "image/png", {
					autoResizeImages: true,
					resizeOptions: ctx?.model?.inputLimits?.images?.resize,
				});
				const note = params.reason?.trim();
				if (!processed.ok) {
					return {
						content: [
							{ type: "text", text: `I took a screenshot but couldn't process it: ${processed.message}` },
						],
						details: { captured: true, platform: process.platform, note },
					};
				}
				const nonVision =
					ctx?.model && !ctx.model.input.includes("image")
						? "\n[Current model does not support images; the screenshot was omitted from this turn.]"
						: "";
				return {
					content: [
						{
							type: "text",
							text: `${note ? "Looking because: " : ""}${processed.hints.length ? `${processed.hints.join("\n")}\n` : "Screenshot of the whole screen:"}${nonVision}`,
						},
						{ type: "image", data: processed.data, mimeType: processed.mimeType },
					],
					details: {
						captured: true,
						platform: process.platform,
						mimeType: processed.mimeType,
						bytes: png.length,
						note,
					},
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `I tried to look at the screen but couldn't: ${msg}` }],
					details: { captured: false, platform: process.platform, note: params.reason?.trim() },
					isError: true,
				};
			}
		},
	};
}
