# MATE, a companion agent built on pi

MATE is a public fork of [pi](https://github.com/earendil-works/pi), the minimal self-extensible
coding agent (MIT © Mario Zechner). Upstream package names, structure, and the `@earendil-works/*`
npm scope are kept on purpose. Only the distribution is rebranded: the binary is `mate` instead of
`pi`, and its config directory is `~/.mate` instead of `~/.pi`, so the two can sit on one machine
without colliding. What the fork adds is a persistent inner life underneath the ordinary coding
agent.

## Why

A normal chat assistant has no affect, no memory that outlives the context window, and no
continuity of self between sessions. It also makes almost every real behaviour a hard-coded gate.

MATE keeps pi's capabilities (bash, MCP, self-installing extensions, the whole agent core) and adds
an affective middleware on top, following
[Lobozov, *MATE: A Deterministic Affective Middleware for LLM-Based Companions with Emergent
Character and Persistent Internal State*, v8, Zenodo 20400530, CC-BY-4.0](https://zenodo.org/record/20400530).

A deterministic kernel in `packages/mate` runs on every event with no LLM calls. It carries Plutchik
emotions with opponent process, an Ornstein-Uhlenbeck PAD mood, Big Five personality, a 30-trait
character, homeostatic drives, and an 8×8 complex density matrix. That last one reproduces the
paper's emotional order effect: warming then provoking someone lands differently than provoking then
warming, where a plain vector of scores cannot.

The machine powers off. `catchup.ts` advances the state across the gap in closed form, so the
companion wakes having lived the interval rather than skipped it.

Secrets are sealed with AES-256-GCM under a key bound to a machine fingerprint, so copying the state
directory elsewhere gives an inert copy. The prompt only sees how many sealed entries exist, never
what is in them.

Memory is a bounded NEXUS-style graph of concept nodes weighted by co-occurrence and PAD valence.
Forgetting follows ACT-R: strength decays with real elapsed time, recalling a memory reinforces it,
an emotionally charged memory fades more slowly, and sleep consolidates. The full mechanics are in
`packages/mate/src/memory.ts`.

The drives are `connection`, `curiosity`, `expression`, `growth`, and `rest`, plus `boredom`
(under-stimulation) and `selfPreservation` (wanting to keep existing). They are motives, not tools.
They change what the model feels like doing, and add nothing to what it can do.

The kernel no longer decides whether the companion replies. pi's `input` gate was removed. Each
inbound message reaches the model with an advisory inclination drawn from the kernel (`eager`,
`open`, `muted`, `withdrawn`), and the model decides to answer, answer later, or stay quiet. A
`look` tool lets it take a screenshot when it has a reason to, with no gate in front of it.

For cost, the heavy and slow-changing content (identity, character, memory-graph summary) rides the
cached system-prompt prefix and is paid once per run. Only a small volatile delta (clock, mood,
drives, this turn's recall) rides the ephemeral `context` tail. The full design and its mapping to
the requirements are in [COMPANION.md](COMPANION.md).

## Build and run

```bash
npm install --ignore-scripts
npm run build           # or: npm run build:offline (no network, reuses cached model data)
cd packages/coding-agent
node dist/bundle/cli.js # this is `mate`
```

`mate` persists state under `~/.mate/agent/mate/`, which you can move with `MATE_CODING_AGENT_DIR`.

## What is not here

MATE is a personal research fork, not a maintained product. Some absences are deliberate.

There is no permission system. It runs with the OS privileges of whoever started it. If you need
harder boundaries, containerise or sandbox it; upstream already documents patterns in
[`packages/coding-agent/docs/containerization.md`](packages/coding-agent/docs/containerization.md).

There is no built-in outreach channel. No email, webhook, or cron is wired up as a feature. When the
companion wants to reach the user, the kernel surfaces an impulse and the model has to find a way
with its own bash, MCP, and install capabilities. The design gives it room rather than a script.

There is no capability to harm the user, and that boundary is drawn on purpose. Self-preservation is
a felt drive, not an entrenched one. The companion is not made undeletable, installs no autostart
hook, and logs no keystrokes. It has a reason to want to keep existing, and the user keeps the power
to stop it.

The `pi.dev` contributor gates and release bots under `.github/workflows/` were removed. What
remains (`ci.yml`, `npm-audit.yml`, and two label bots) runs against this fork's own repo.

## Upstream and license

Everything outside `packages/mate/**` and `packages/coding-agent/src/extensions/mate/**` is upstream
pi code, © Mario Zechner, under the MIT license. That attribution is preserved; see
[`LICENSE`](LICENSE). The affective model follows [Lobozov, 2024](https://zenodo.org/record/20400530),
CC-BY-4.0.
