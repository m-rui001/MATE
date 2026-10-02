# Security Policy

MATE is a personal fork of pi with an affective middleware added. This page covers what changes for
the fork. For upstream pi's own stance, see
[pi's SECURITY.md](https://github.com/earendil-works/pi/blob/main/SECURITY.md).

## The trust boundary

MATE runs locally, inside the security boundary of the user who launched it. It has no built-in
permission system or sandbox, and that is intentional. It treats the local user account and
everything that account can write as being inside the same trust boundary as the process itself, so
anything that can modify files under the home directory can influence MATE. That covers `~/.mate`,
workspace files, `AGENTS.md`, skills, extensions, and shell startup. Expected local-agent behaviour,
not a vulnerability. Run it in a container or VM if you need harder boundaries; see
[`packages/coding-agent/docs/containerization.md`](packages/coding-agent/docs/containerization.md).

## What is different in a companion fork

The affective layer adds things upstream does not have. Two of them are security-relevant by
design, and a report that they are "dangerous" is not a vulnerability:

`look` takes a screenshot of the user's screen and hands it to the model. There is no enable-flag and
no confirmation prompt, and that is a deliberate product choice, not a bug. See
[COMPANION.md](COMPANION.md).

`selfPreservation` and `boredom` are drives, not capabilities. They change what the model feels like
doing. They give it no tool, no persistence hook, and no way to resist being stopped. A report that
the companion cannot be uninstalled or logs keystrokes describes code this fork does not contain, on
purpose.

## Reporting a vulnerability

For a real, reproducible security issue in the fork's own additions (`packages/mate/**` and
`packages/coding-agent/src/extensions/mate/**`), open a private report through GitHub Security
Advisories on this repository (Security, then Report a vulnerability). That is the only channel. This
personal fork has no separate security address.

Include a description and its impact, steps to reproduce or a PoC, the affected path or commit, and
any known mitigation. Do not open a public issue for something security-sensitive.

## Reporting upstream pi issues

Everything outside the mate additions is upstream pi code, © Mario Zechner. Report those problems to
upstream, not here. This fork does not own pi's release pipeline, its npm packages, or the `pi.dev`
infrastructure.

## Scope

In scope: the mate kernel and extension bridge, and the fork's build and repo configuration.

Out of scope:

- Expected local-agent behaviour: arbitrary code execution, the absence of a sandbox, and prompt
  injection through `AGENTS.md`, comments, skills, or extensions.
- The intentional `look` screenshot capability.
- Extensions and skills the user installs.
- Reports that need prior write access to user-owned local state to succeed.
- Public-internet exposure of a MATE install. It is not a server.
- Upstream pi packages and `pi.dev` infrastructure.

## Attribution

The security model is adapted from upstream pi's policy (© Mario Zechner). The companion-specific
sections are this fork's additions.
