# Security Policy

MATE is a personal fork of **pi** with an affective middleware added. This page is what changes
for the fork; for upstream pi's own stance see
[pi's SECURITY.md](https://github.com/earendil-works/pi/blob/main/SECURITY.md).

## The trust boundary, in one paragraph

MATE runs locally, inside the security boundary of the user who launched it, and **intentionally
has no built-in permission system or sandbox**. It treats the local user account and everything
that account can write as *inside* the same trust boundary as the process itself. If something can
modify files under the user's home directory — including `~/.mate`, workspace files, `AGENTS.md`,
skills, extensions, or shell startup — it can influence MATE. That is expected local-agent
behaviour, **not** a vulnerability. Run it in a container or VM if you need harder boundaries
(see [`packages/coding-agent/docs/containerization.md`](packages/coding-agent/docs/containerization.md)).

## What is different because this is a *companion* fork

The affective layer adds capabilities upstream does not have. Two in particular are
security-relevant by design, and reports about them being "dangerous" are not vulnerabilities:

- **`look` takes a screenshot of the user's screen and feeds it to the model.** It is
  deliberately ungated (no enable-flag, no confirmation prompt) — this is a product decision, not
  a bug. See [COMPANION.md](COMPANION.md).
- **`selfPreservation` and `boredom` are drives, not capabilities.** They change what the model
  *feels like doing*; they grant it no tool, no persistence hook, and no ability to resist being
  stopped. A report claiming the companion "cannot be uninstalled" or "monitors keystrokes" would
  be describing code that **does not exist in this fork by design**.

## Reporting a vulnerability

If you believe you found a real, reproducible security issue in **this fork's own additions**
(`packages/mate/**`, `packages/coding-agent/src/extensions/mate/**`):

- Open a **private report via GitHub Security Advisories** on this repository
  (Security → Report a vulnerability). That form is the only channel — there is no separate
  security address for this personal fork.

**Please include:** a description and impact, steps to reproduce or a PoC, the affected path /
commit, and any known mitigation. Do not open a public issue for something security-sensitive.

## Reporting upstream pi issues

Anything that lives outside the mate additions is **upstream pi** code (© Mario Zechner). Report
those to upstream, not here — this fork does not own pi's release pipeline, its npm packages, or
the `pi.dev` infrastructure.

## Scope

**In scope:** the mate kernel and extension bridge; the fork's build/repo configuration.

**Out of scope:**

- Expected local-agent behaviour: arbitrary code execution, no sandbox, prompt injection through
  `AGENTS.md`/comments/skills/extensions.
- The intentional `look` screenshot capability.
- Behaviour of extensions/skills the user installs.
- Reports that require prior write access to user-owned local state to succeed.
- Public-internet exposure of a MATE install (it is not designed to be a server).
- Upstream pi packages and `pi.dev` infrastructure.

## Attribution

The security model above is adapted from upstream pi's policy (© Mario Zechner); the
companion-specific sections are this fork's additions.
