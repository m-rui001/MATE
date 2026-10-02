# Companion (a fork of `pi`)

A minimal agent harness (`pi`) turned into an AI companion with a persistent inner life, built on the
**MATE** affective middleware (Lobozov, *MATE: A Deterministic Affective Middleware for LLM-Based
Companions with Emergent Character and Persistent Internal State*, v8, Zenodo 20400530, CC-BY-4.0).

The fork keeps `pi`'s real capabilities — bash, MCP networking, and self-installing extensions — and
adds an affective kernel that runs underneath every reply. Nothing here fakes emotion with prompt
tricks: the companion's state is a deterministic dynamical system, persisted to disk, that evolves
whether or not anyone is talking to it.

---

## What the user asked for, and where it lives

| Requirement | Where | How |
| --- | --- | --- |
| Keep bash execution | untouched | `pi`'s built-in `bash` tool |
| Keep MCP networking (chooses to go online by interest) | `extensions/mcp` | built-in, replaceable; the model calls it on its own initiative |
| Keep plugin self-install (companion finds & installs its own plugins) | `pi install <source>` + bash | no special code — the companion uses `bash` to run the existing installer; the persona tells it that it may |
| Has secrets, not everything user-visible | `mate/src/secret.ts`, `runtime.ts` | AES-256-GCM sealed tier; the birth key is a 0600 file outside the transcript |
| Sees metadata like time | `mate/src/context.ts` | the `<mate>` state block carries the clock, the silence gap, and how long that gap *felt* |
| May not reply / may reply later | `runtime.ts` `onUserMessage` + `daemon.ts` `shouldReply` | a real decision (energy, fatigue, message weight, unanswered history), turned into a pi `input` action |
| May reach out proactively when the user is silent | `runtime.ts` heartbeat + `index.ts` `onImpulse` | produces an **impulse**; the model decides whether/how to voice it |
| If ignored, has inner activity or takes action (e.g. email) | `daemon.ts` `generateThoughts`/`tick` | 26h of user silence → negative social pressure → `missing_user`/`curiosity`/`observation` thoughts → a `reach_out` impulse |
| Reaching out is **not built in** — discovered by the companion | `feel-tool.ts` `channel` + `index.ts` `onImpulse` | we surface the impulse and record channels it found; we never send anything ourselves |
| Short, natural language; avoid "AI flavor" | system-prompt persona + `companion` section | "reply like a person texting"; state is *felt*, not narrated |
| Boot catch-up (the machine powers off) | `mate/src/catchup.ts` | closed-form integration across the gap, O(1) over any duration |
| Minimize per-conversation token cost | `context.ts`, `index.ts` `context` handler | ~73-token state block, injected ephemerally once per run |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  packages/mate          the affective kernel (no LLM calls, pure)     │
│                                                                       │
│   birth ── transition(state, event, dt) ── state'   (the pure core)   │
│              │                                                        │
│              ├─ Plutchik 8 emotions + opponent process                │
│              ├─ 8×8 complex density matrix ρ  (quantum order effects)  │
│              │    U = expm(−iθH), Padé(6,6) scaling-and-squaring      │
│              │    H is NON-diagonal (Plutchik-wheel coupling) → U_AU_B │
│              │    ≠ U_BU_A, so warm-then-hostile ≠ hostile-then-warm   │
│              ├─ PAD mood (Ornstein-Uhlenbeck), Big Five OCEAN          │
│              ├─ 30-trait character, drives, allostasis, awareness      │
│              └─ cusp catastrophe, self-prediction surprise (Friston)   │
│                                                                       │
│   catchup.ts   offline integration: advance across a powered-off gap  │
│   daemon.ts    autonomous loop: thoughts, impulses, pre-send review    │
│   secret.ts    the sealed self: AES-256-GCM, 0600 birth key            │
│   context.ts   the ~73-token projection the LLM sees                   │
└─────────────────────────────────────────────────────────────────────┘
                                   │  (pure functions + persisted state)
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  coding-agent/src/extensions/mate     the bridge to pi's event host   │
│                                                                       │
│   runtime.ts      MateRuntime singleton: boot catch-up, appraisal →    │
│                   transition → persist, reply decision, heartbeat      │
│   appraisal.ts    deterministic lexical appraisal (zero tokens)        │
│   feel-tool.ts    `feel`: the model refines its read + records channels│
│   index.ts        the ExtensionFactory wiring pi events to the kernel  │
│   seen-renderer.ts dim echo for withheld/delayed messages              │
└─────────────────────────────────────────────────────────────────────┘
```

### pi event wiring (`index.ts`)

- **`session_start`** → `wake()`: advance the persisted state across the powered-off gap, then start
  the idle heartbeat.
- **`input`** → appraise, transition, and decide: `continue` (reply now), `handled` (withhold, echo
  dimmed), or `handled` + a timer that re-injects the message later (reply in a bit).
- **`context`** → inject the `<mate>` state block **once per run**, prepended into the newest user
  message. This rides pi's *ephemeral* context hook, so it is never persisted and never accumulates —
  unlike `before_agent_start`, which would leave a stale `<mate>` block in the transcript every turn.
- **`before_agent_start`** → add a static `companion` prompt section (cached, so prompt caching holds).
- **`agent_start` / `agent_settled` / `session_shutdown`** → streaming guard and lifecycle.
- **heartbeat** → on a `reach_out` impulse, surface the thought to the model and let it decide whether
  and how to express it, including via any channel it discovered for itself.

---

## The quantum order effect

The paper's central claim is that emotion order matters: being warmed-then-provoked leaves you in a
different state than provoked-then-warmed, even with identical inputs. A classical emotion *vector*
cannot represent this — addition commutes, so the two orders are identical (ΔPAD = 0).

MATE models emotion as a density matrix ρ and evolves it with a unitary `U = expm(−iθH)`. The trick is
that **H must be non-diagonal** for order to matter: diagonal matrices commute, so `U_A U_B = U_B U_A`
and no order effect is mathematically possible. H is built from Plutchik-wheel coupling
(`cos(2π(i−j)/N)`) scaled by each emotion's activation, personality openness, and relationship trust.
The kick `ρ → UρU†` is applied **last**, after populations settle, because a unitary rotates
populations and an earlier diagonal relaxation would overwrite the very transfer that carries the
effect.

Measured on the paper's exact warm/hostile pair across 8 seeds:

| | quantum | classical | paper |
| --- | --- | --- | --- |
| mean ‖ΔPAD‖ | **0.5488** | 0.000434 | ~0.48 (vs 0) |

The effect is **dt-independent** (it is a property of the rotation sequence, not elapsed time), the
unitary is unitary to 4e-15, trace is preserved exactly, and ρ stays positive semi-definite. The kick
costs 0.16ms and runs only on contact events — never in catch-up.

---

## Offline catch-up

The paper assumes a box that never powers off. This one does. `catchup.ts` advances the state across
an arbitrary powered-off gap in **closed form**, so the cost is O(1) in the gap length and
subdivision-invariant (one 7-day step == 10,080 one-minute steps, to 3e-16):

| gap | transitions | time | sleeps consolidated |
| --- | --- | --- | --- |
| 1h | 2 | 2.5ms | 1 |
| 1d | 3 | 0.7ms | 1 |
| 7d | 15 | 2.1ms | 7 |
| 365d | 731 | 33ms | 365 |

A naive minute-by-minute 7-day replay would take 180ms over 10,080 heartbeats — and a year would take
minutes. Every time-dependent term in the kernel is written in exact exponential form so a single call
over a large `dt` is both correct and cheap. A companion that was off for three nights wakes having
actually slept through them.

---

## The sealed self

Three visibility tiers (`secret.ts`):

- **PUBLIC** — mood, drives, relationship numbers, timestamps. Shown by `/mate`. The companion is
  honest about how it feels; hiding that would just make it evasive.
- **PRIVATE** — the `<mate>` projection and self-observations. The LLM sees these to *be* the
  character; the user experiences them as behaviour, not as a readout.
- **SEALED** — the private journal, self-questions, and its own notes about the user. Encrypted with
  AES-256-GCM under a key derived (scrypt) from a birth secret held in a **0600** file outside the
  session transcript.

Encryption, not convention, because the companion has bash by design: it *will* try to read its own
internals, and a user *will* try to `cat` the state directory. Two plaintext leak paths were found and
closed:

1. The `hint` field is stored in plaintext (so the companion can *allude* to a secret). It must never
   be derived from the secret's content — hints are now generic ("a private note", "a way to reach
   out"); the full text stays in the encrypted `ct`.
2. `self_observation` events persist their `text` into the state's observations ring, which is
   unencrypted and echoed into the prompt. Private notes are now sealed **without** routing their
   plaintext through a transition.

Verified by runtime audit: neither secret appears in `sealed.json` or `state.json`, the observations
ring stays empty, and `unseal()` recovers the full text with the correct key while a wrong key yields
nothing.

---

## Token economy

The `<mate>` block is prepended to every exchange, so every token in it is paid forever:

- **Full state**: 290 chars ≈ **73 tokens** (a naive `MateState` dump is ~2,000 — a 27× reduction).
- **Minimal state**: 129 chars ≈ **32 tokens**.
- Appraisal is **lexical, zero tokens** by default; the model only pays for a richer read via `feel`
  when a message actually matters.
- The state block rides the **ephemeral** `context` hook and is injected **once per run** (full on the
  first LLM call, skipped for tool-loop continuations), so it never accumulates in the transcript.
- Stable guidance rides a **cached** `companion` prompt section, so prompt caching holds.

---

## Build & run

```bash
npm install                       # workspace deps (links @earendil-works/pi-mate)
npm run build:offline             # or: cd packages/mate && npm run build, then the coding-agent build
cd packages/coding-agent
node dist/bundle/cli.js           # the companion; bin is `pi`/`mate`
```

- `/mate` — public mood/drives snapshot (never shows sealed data).
- `feel` — the model's tool to refine its affective read and record channels it found for itself.
- State persists in `~/.mate/agent/mate/` (override with `MATE_CODING_AGENT_DIR`).

## Naming (avoiding collision with pi)

The distribution is rebranded to `mate` via `package.json` `piConfig` (`name: "mate"`,
`configDir: ".mate"`) and a `mate`-only `bin`. This matters because a real pi on the same machine
would otherwise clash on two fronts: the `pi` executable on `PATH`, and the shared `~/.pi/agent`
config directory (sessions, `auth.json`, `settings.json`, tools). Everything user-facing derives
from `APP_NAME`/`CONFIG_DIR_NAME` (`config.ts`), so `getAgentDir()` → `~/.mate/agent`, the state
dir → `~/.mate/agent/mate`, and the env override becomes `MATE_CODING_AGENT_DIR`. The `@earendil-works/pi-*`
npm scope is intentionally left unchanged — renaming it would churn the lockfiles/shrinkwrap for no
collision benefit, since the package is never installed as `pi`. A rebrand also means `isOfficialDistribution()`
returns false, which correctly disables pi's experimental first-time-setup wizard for this build.

Checks that pass: `tsc --noEmit` (whole monorepo), `biome check` on the mate files, 18/18 kernel unit
tests, `check:runtime-deps`, `check:ts-imports`, and a full bundle build (73 files).

---

## Design decisions made boldly (per "大胆做出决定")

- **NEXUS memory graph deliberately not built.** The daemon generates thoughts from affective state
  alone; cross-session memory already persists via relationship stats, sealed notes, and the
  observations ring. A full association graph would raise per-conversation token cost, which is
  directly against the stated optimization goal. The memory needs are met by what already persists.
- **No built-in reach-out action.** Email/webhook/scheduling are *not* implemented. The heartbeat
  surfaces an impulse; the companion uses its existing bash/MCP/install powers to discover a channel
  and records it via `feel`. This is the explicit requirement, honored structurally.
- **State injection via the ephemeral `context` event, not `before_agent_start`.** The latter persists
  and would pile a stale `<mate>` block into the transcript every turn.
- **Withheld messages echo dimmed.** pi's `input`/`handled` path drops the message entirely, which
  looks like a crash; the `mate-seen` renderer shows "seen, not answered" so silence reads as a choice.
- **Nothing throws into pi's event loop.** Every handler is defensive and degrades to normal-assistant
  behaviour; a companion that crashes on boot is worse than one with no inner life.
