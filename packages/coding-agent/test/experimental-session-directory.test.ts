import { homedir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { resolveSessionDirectory } from "../src/experimental/server.ts";

afterEach(() => vi.unstubAllEnvs());

describe("experimental server session directory", () => {
	test("uses the experimental directory under the configured agent directory by default", () => {
		vi.stubEnv(ENV_AGENT_DIR, "/tmp/pi-agent-config");

		expect(resolveSessionDirectory()).toBe("/tmp/pi-agent-config/experimental/sessions");
	});

	test("resolves an explicit relative directory from the current working directory", () => {
		vi.stubEnv(ENV_AGENT_DIR, "/tmp/pi-agent-config");

		expect(resolveSessionDirectory("relative/sessions")).toBe(resolve("relative/sessions"));
	});

	test("expands a tilde in an explicit directory", () => {
		expect(resolveSessionDirectory("~/custom-sessions")).toBe(resolve(homedir(), "custom-sessions"));
	});
});
