# Contributing to MATE

MATE is a **personal fork of [pi](https://github.com/earendil-works/pi)** with an affective
middleware bolted on. It is not a maintained product; there is no maintainer team, no triage
queue, no `lgtm` ritual. If you open an issue or a PR here, expect a single human to read it
when they get a chance.

## Ground rules (borrowed from upstream, minus the gate)

- **Understand your code.** If you cannot explain what a change does and how it interacts with
  the rest of the system, it will not land. Using an agent to write code is fine; submitting
  unreviewed output is not.
- Run the pre-flight before opening a PR:

  ```bash
  npm run check
  ./test.sh
  ```

  Both must pass.
- Do **not** edit `CHANGELOG.md`. Upstream pi owns its changelog; this fork inherits it.
- If your change belongs in the pi core (anything outside `packages/mate/**` and
  `packages/coding-agent/src/extensions/mate/**`), it probably belongs upstream, not here.

## What this fork will and will not accept

**Welcome:**

- Improvements to the affective kernel, the memory/forgetting model, the sealed-self boundary,
  or the extension bridge under `packages/*/extensions/mate`.
- Bug fixes with reproductions and tests.
- Documentation corrections.

**Will not:**

- Changes that give the companion **covert or entrenched capabilities** — autostart hooks,
  anti-uninstall measures, keylogging, deletion-evasion, or "harm the user" abilities. The
  design principle is: the companion has *motivation* without any tool the user has not already
  granted it. Read the "Design decisions" section of
  [COMPANION.md](COMPANION.md) before proposing anything in this space.
- Reinstating upstream pi's contributor gates (they were deliberately removed — the
  `APPROVED_CONTRIBUTORS` list is other people's data and the auto-close bots misfire on this
  fork's contributors).
- Removal of the pi upstream attribution in `LICENSE`. MIT requires we keep it.

## Reporting a vulnerability

See [`SECURITY.md`](SECURITY.md). For issues that are about **upstream pi**, please report them
to upstream instead of here — this fork does not own their release pipeline.

## Attribution

Everything outside `packages/mate/**` and `packages/coding-agent/src/extensions/mate/**` is
upstream pi, © Mario Zechner, MIT-licensed.
