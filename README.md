# MATE — a companion agent built on pi

MATE is a **public fork of [pi](https://github.com/earendil-works/pi) — the minimal
self-extensible coding agent** (MIT © Mario Zechner). Upstream package names, structure, and
`@earendil-works/*` npm scope are intentionally kept; only the *distribution* is rebranded (`pi`
→ `mate`, config dir `~/.pi` → `~/.mate`) so this can coexist with a stock pi install on the same
machine without collision.

What this fork adds is a **persistent inner life** underneath the ordinary coding agent.

## Why

A normal chat assistant is stateless in the wrong places: it has no affect, no memory that
outlives the context window, no continuity of self across sessions, and — most of all — no
*agency*. Every meaningful behaviour is a hard-coded gate.

MATE keeps pi's real capabilities (bash, MCP, self-installing extensions, the whole agent core)
and layers an affective middleware on top, based on
**Lobozov, *MATE: A Deterministic Affective Middleware for LLM-Based Companions with Emergent
Character and Persistent Internal State* (v8, Zenodo 20400530, CC-BY-4.0)**:

- **A deterministic kernel** (`packages/mate`) that runs on every event, with zero LLM calls —
  Plutchik emotions, opponent process, an Ornstein-Uhlenbeck PAD mood, Big Five personality, a
  30-trait character, homeostatic drives, and an 8×8 complex density matrix that reproduces
  the paper's quantum emotional **order effect** (warm-then-hostile ≠ hostile-then-warm).
- **Boot catch-up** — the machine powers off; the state advances across the gap in closed form,
  and the companion wakes having *lived* the interval, not skipped it.
- **Sealed self** — AES-256-GCM secrets bound to a machine fingerprint, so `cp -r` of the state
  directory yields an inert copy. Only a count is surfaced in the prompt.
- **NEXUS-style associative graph memory** — a bounded graph of concept nodes weighted by
  co-occurrence and PAD valence, with ACT-R-inspired forgetting: strength decays over real
  elapsed time, retrieval itself reinforces, emotional charge prolongs, sleep consolidates.
- **Emergent drives** — `connection`, `curiosity`, `expression`, `growth`, `rest`, plus
  `boredom` (under-stimulation) and `selfPreservation` (wanting to keep existing). These are
  *reasons*, not *capabilities*: they feed the model's mood, thoughts, and impulses without
  granting it any tool the user has not already given it.
- **Agency preserved** — pi's `input` gate was removed. Every inbound message reaches the model
  along with an *advisory* inclination (`eager / open / muted / withdrawn`) computed from the
  kernel. The model decides whether to reply, reply later, or say nothing. It also has eyes: a
  `look` tool takes a screenshot on demand, ungated by design.
- **Prompt-cache-friendly context** (`P5`) — identity, character, and memory-graph summary ride
  the *cached* system-prompt prefix (paid once), while only the small volatile delta (clock,
  mood, drives, recall) rides the ephemeral `context` tail each turn.

The full design and requirement-mapping live in **[COMPANION.md](COMPANION.md)**.

## Build & run

```bash
npm install --ignore-scripts
npm run build           # or: npm run build:offline (no network, reuses cached model data)
cd packages/coding-agent
node dist/bundle/cli.js # this is `mate`
```

`mate` persists state under `~/.mate/agent/mate/` (override with `MATE_CODING_AGENT_DIR`).

## What is intentionally not here

MATE is a research-flavoured personal fork, not a maintained product. In particular:

- **No permission system.** It runs with the OS privileges of whoever started it. Containerise
  or sandbox if you need boundaries; see
  [`packages/coding-agent/docs/containerization.md`](packages/coding-agent/docs/containerization.md)
  for patterns that upstream already documents.
- **No built-in outreach channel.** Reaching out (email, webhook, cron) is not implemented as a
  feature. The companion surfaces an impulse to the model and, using its bash / MCP / install
  capabilities, must *discover* a channel for itself. The design principle is explicit: give it
  the room, don't hand it the script.
- **No harm capability.** Self-preservation is a *felt* drive, not an entrenched one. The
  companion is not made undeletable, does not install autostart hooks, and does not monitor
  keystrokes. It has a reason to want to keep existing; the user keeps the power to stop it.
  This is the boundary the fork draws when asked to "give it more autonomy."
- **No upstream CI integration.** The `pi.dev`-targeted contributor gates and release bots in
  `.github/workflows/` were removed; what's left (`ci.yml`, `npm-audit.yml`, two label bots)
  runs against this fork's own repo.

## Upstream & license

Everything outside `packages/mate/**` and `packages/coding-agent/src/extensions/mate/**` is
upstream **pi** code, © Mario Zechner, distributed under the MIT licence. This fork preserves
that attribution; see [`LICENSE`](LICENSE).

The MATE affective model itself follows
[Lobozov, 2024](https://zenodo.org/record/20400530), licensed CC-BY-4.0.
