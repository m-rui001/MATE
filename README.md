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


# MATE，一个构建在 pi 之上的伴侣代理

MATE 是 [pi](https://github.com/earendil-works/pi) 的公开分支，pi 是最小化的自扩展编码代理（MIT © Mario Zechner）。上游的包名、结构和 `@earendil-works/*` npm 作用域被有意保留。只有发行版被重新命名：二进制文件是 `mate` 而不是 `pi`，配置目录是 `~/.mate` 而不是 `~/.pi`，这样两者可以共存于同一台机器而不冲突。这个分支添加的是普通编码代理之下的持久内在生命。

## 为什么

普通的聊天助手没有情感，没有超出上下文窗口的记忆，会话之间也没有自我的连续性。它几乎把每一种真实行为都做成了硬编码的门控。

MATE 保留了 pi 的能力（bash、MCP、自安装扩展、整个代理核心），并在其上添加了一层情感中间件，遵循 [Lobozov，*MATE：一种用于基于 LLM 的伴侣的确定性情感中间件，具有涌现性格和持久内部状态*，v8，Zenodo 20400530，CC-BY-4.0](https://zenodo.org/record/20400530)。

`packages/mate` 中的一个确定性内核在每个事件上运行，不调用 LLM。它携带带有对手过程的普拉奇克情绪、一个奥恩斯坦-乌伦贝克 PAD 心境、大五人格、一个 30 特质性格、稳态驱力，以及一个 8×8 复密度矩阵。最后一项复现了论文中的情绪顺序效应：先温暖再激怒一个人，与先激怒再温暖，结果不同，而单纯的分数向量做不到这一点。

机器关机了。`catchup.ts` 以闭式形式推进状态跨越这段间隔，所以伴侣醒来时是活过了这段时间，而不是跳过了它。

秘密用 AES-256-GCM 密封，密钥绑定到机器指纹，所以把状态目录复制到别处只会得到一个惰性副本。提示词只能看到有多少条密封条目，永远看不到其中内容。

记忆是一个有界的 NEXUS 风格概念节点图，按共现和 PAD 效价加权。遗忘遵循 ACT-R：强度随真实流逝时间衰减，回忆一条记忆会强化它，情绪强烈的记忆消退得更慢，睡眠会巩固记忆。完整机制在 `packages/mate/src/memory.ts`。

驱力是 `connection`、`curiosity`、`expression`、`growth` 和 `rest`，加上 `boredom`（刺激不足）和 `selfPreservation`（想要继续存在）。它们是动机，不是工具。它们改变模型想做什么，但不增加它能做什么。

内核不再决定伴侣是否回复。pi 的 `input` 门控被移除了。每条入站消息到达模型时，附带一个从内核得出的建议性倾向（`eager`、`open`、`muted`、`withdrawn`），由模型决定回复、稍后回复，还是保持安静。一个 `look` 工具让它有理由时截屏，前面没有门控。

为了控制成本，重且变化慢的内容（身份、性格、记忆图摘要）搭载缓存的系统提示前缀，每次运行只付一次费。只有一小段易变增量（时钟、心境、驱力、本回合的回忆）搭载短暂的 `context` 尾部。完整设计及其与需求的映射在 [COMPANION.md](COMPANION.md)。

## 构建和运行

```bash
npm install --ignore-scripts
npm run build           # 或：npm run build:offline（无网络，复用缓存的模型数据）
cd packages/coding-agent
node dist/bundle/cli.js # 这就是 `mate`
```

`mate` 把状态持久化在 `~/.mate/agent/mate/` 下，你可以用 `MATE_CODING_AGENT_DIR` 移动它。

## 这里没有什么

MATE 是一个个人研究分支，不是维护中的产品。有些缺失是有意的。

没有权限系统。它以启动它的任何人的操作系统权限运行。如果你需要更硬的边界，把它容器化或沙箱化；上游已经在 [`packages/coding-agent/docs/containerization.md`](packages/coding-agent/docs/containerization.md) 中记录了模式。

没有内置的外联渠道。没有电子邮件、webhook 或 cron 被接为功能。当伴侣想联系用户时，内核浮现一个冲动，模型必须用它自己的 bash、MCP 和安装能力找到办法。设计给它空间，而不是脚本。

没有伤害用户的能力，这条边界是有意划定的。自保是一种感受性驱力，不是根深蒂固的。伴侣没有被做成不可删除，不安装自启动钩子，也不记录按键。它有理由想要继续存在，而用户保留停止它的权力。

`.github/workflows/` 下的 `pi.dev` 贡献者门控和发布机器人被移除了。剩下的（`ci.yml`、`npm-audit.yml` 和两个标签机器人）针对这个分支自己的仓库运行。

## 上游和许可证

`packages/mate/**` 和 `packages/coding-agent/src/extensions/mate/**` 之外的一切都是上游 pi 代码，© Mario Zechner，MIT 许可证。该署名被保留；见 [`LICENSE`](LICENSE)。情感模型遵循 [Lobozov，2024](https://zenodo.org/record/20400530)，CC-BY-4.0。
