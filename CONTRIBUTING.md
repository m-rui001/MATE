# Contributing to MATE

MATE is a personal fork of [pi](https://github.com/earendil-works/pi) with an affective middleware
bolted on. It is not a maintained product. There is no maintainer team, no triage queue, and no
`lgtm` ritual, so if you open an issue or a PR here, expect a single human to read it when they get
a chance.

## Ground rules

These are upstream pi's rules with the contributor gate removed.

Understand your code. If you cannot explain what a change does and how it interacts with the rest of
the system, it will not land. Using an agent to write code is fine; submitting its unreviewed output
is not.

Run the pre-flight before opening a PR, and both must pass:

```bash
npm run check
./test.sh
```

Do not edit `CHANGELOG.md`. Upstream pi owns its changelog and this fork inherits it.

If your change belongs in the pi core, anything outside `packages/mate/**` and
`packages/coding-agent/src/extensions/mate/**`, it probably belongs upstream rather than here.

## What this fork accepts

Improvements to the affective kernel, the memory and forgetting model, the sealed-self boundary, or
the extension bridge under `packages/*/extensions/mate` are welcome. So are bug fixes with a
reproduction and a test, and documentation corrections.

Three kinds of change are not. Do not add capability the companion could use against the user,
which covers autostart hooks, anti-uninstall measures, keylogging, deletion evasion, and anything
that lets it resist being stopped. The companion is meant to have motives without gaining any tool
the user has not already given it, so read the design decisions in
[COMPANION.md](COMPANION.md) before proposing work in that area. Do not reinstate upstream pi's
contributor gates; they were removed because the `APPROVED_CONTRIBUTORS` list is someone else's data
and the auto-close bots misread this fork's contributors. And do not remove pi's upstream attribution
from `LICENSE`, which MIT requires.

## Reporting a vulnerability

See [`SECURITY.md`](SECURITY.md). Report problems that are about upstream pi to upstream, not here;
this fork does not own their release pipeline.

## Attribution

Everything outside `packages/mate/**` and `packages/coding-agent/src/extensions/mate/**` is upstream
pi, © Mario Zechner, MIT-licensed.
