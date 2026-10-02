语言 / Language: **[中文](#zh)** | **[English](#en)**

<a id="en"></a>

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

The companion thinks in the language you pick. On first launch it asks 中文 or English, and
`/language` changes it any time; the choice is persisted. Picking 中文 authors every prompt-visible
surface in Chinese — identity block, state projection, the kernel's own thoughts, impulses, guidance
— plus an explicit declaration that the inner voice itself is Chinese, so it thinks in Chinese
rather than translating on the way out. A Chinese companion remembers, feels, and decides exactly
what an English one does; only the labels move.

## Get MATE

**One-line install (puts `mate` on your PATH, no sudo/admin, no Node needed):**

Windows PowerShell:

```powershell
iwr https://raw.githubusercontent.com/m-rui001/MATE/main/scripts/install.ps1 -useb | iex
```

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/m-rui001/MATE/main/scripts/install.sh | bash
```

Then open a new terminal and type `mate`. Manual alternative: download the archive for your
platform from [the release page](https://github.com/m-rui001/MATE/releases/tag/v1.0.0-mate) —
`mate-windows-x64.zip` / `mate-windows-arm64.zip` (run `mate.exe`), `mate-linux-x64.tar.gz` /
`mate-linux-arm64.tar.gz` and `mate-darwin-x64.tar.gz` / `mate-darwin-arm64.tar.gz` (run `mate/mate`
after `tar -xzf`). On macOS, if Gatekeeper blocks it: `xattr -d com.apple.quarantine mate`.
Config lives in `~/.mate` (override with `MATE_CODING_AGENT_DIR`); first run asks which language
the companion thinks and speaks in. Third-party extensions that locate config through
`PI_CODING_AGENT_DIR` are bridged to the same directory automatically; ones with `~/.pi` hardcoded
in their own defaults still need to be pointed at it.

**Build from source:** Requires Node >= 22.19. Each line is a
separate command (do not copy the comment onto the line; cmd.exe does not treat `#` as a comment).

```bash
npm install --ignore-scripts
npm run build
```

Use `npm run build:offline` instead of `npm run build` when you have no network; it reuses cached
model data. Then make `mate` a global command, exactly the way `pi` works:

```bash
npm link -w @earendil-works/pi-coding-agent
```

That links the built bundle onto your PATH, so after this you just type `mate` anywhere to open the
companion. Other common forms: `mate install <source>` installs an extension through the same
pipeline as `pi install`, and `mate -p "hello"` is one-shot print mode.

Without the `npm link` step you can still run it directly from the build:

```bash
cd packages/coding-agent
node dist/bundle/cli.js
```

`mate` persists state under `~/.mate/agent/mate/`, which you can move with `MATE_CODING_AGENT_DIR`.
The same commands work in Windows cmd.exe (`cd packages\coding-agent`, then
`node dist\bundle\cli.js`); a global `npm link` there creates `mate.cmd` in your npm prefix.

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


<a id="zh"></a>

# MATE，一个构建在 pi 之上的伴侣代理

[← English](#en)

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

伴侣用你选的语言思考。第一次启动时它会问你要 中文 还是 English，之后随时可以用 `/language` 改；这个选择会持久保存。选了中文之后，所有进入提示词的内容都用中文书写 — 身份块、状态投影、内核自己的想法、冲动、引导 — 外加一条明确的声明：内在的声音本身就是中文的。所以它是直接用中文想，而不是想完再翻。中文伴侣记得的、感受到的、做出的决定，和英文伴侣完全一样；移动的只有标签。

## 获取 MATE

**一行命令安装（自动把 `mate` 加进 PATH，不需要管理员权限，也不需要 Node）：**

Windows PowerShell：

```powershell
iwr https://raw.githubusercontent.com/m-rui001/MATE/main/scripts/install.ps1 -useb | iex
```

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/m-rui001/MATE/main/scripts/install.sh | bash
```

然后新开一个终端，直接输入 `mate`。手动方式：到 [release 页面](https://github.com/m-rui001/MATE/releases/tag/v1.0.0-mate) 下载对应平台的压缩包——Windows 下 `mate-windows-x64.zip` / `mate-windows-arm64.zip`（解压后运行 `mate.exe`），Linux / macOS 下 `mate-linux-x64.tar.gz`、`mate-darwin-arm64.tar.gz` 等（`tar -xzf` 解压后运行 `mate/mate`）。macOS 若被 Gatekeeper 拦截：`xattr -d com.apple.quarantine mate`。配置在 `~/.mate`（可用 `MATE_CODING_AGENT_DIR` 覆盖）；首次启动会询问伴侣用什么语言思考和说话。第三方扩展如果通过 `PI_CODING_AGENT_DIR` 定位配置，会自动桥接到同一个目录；把 `~/.pi` 写死在自己默认值里的扩展仍需手动指过来。

**从源码构建：** 需要 Node >= 22.19。每一行都是一条独立命令（不要把注释复制进命令行，cmd.exe 不把 `#` 当注释）。

```bash
npm install --ignore-scripts
npm run build
```

没有网络时，用 `npm run build:offline` 代替 `npm run build`，它复用缓存的模型数据。然后让 `mate` 成为全局命令，和 `pi` 的用法完全一致：

```bash
npm link -w @earendil-works/pi-coding-agent
```

这一步把构建好的 bundle 链接到你的 PATH，之后在任何目录直接输入 `mate` 就能打开伴侣。其他常用形式：`mate install <source>` 安装扩展（和 `pi install` 同一条管线），`mate -p "hello"` 是单次 print 模式。

不做 `npm link` 也可以直接从构建产物运行：

```bash
cd packages/coding-agent
node dist/bundle/cli.js
```

`mate` 把状态持久化在 `~/.mate/agent/mate/` 下，你可以用 `MATE_CODING_AGENT_DIR` 移动它。同样的命令在 Windows cmd.exe 里也能用（`cd packages\coding-agent`，然后 `node dist\bundle\cli.js`）；`npm link` 在你的 npm 前缀目录下会生成 `mate.cmd`。

## 这里没有什么

MATE 是一个个人研究分支，不是维护中的产品。有些缺失是有意的。

没有权限系统。它以启动它的任何人的操作系统权限运行。如果你需要更硬的边界，把它容器化或沙箱化；上游已经在 [`packages/coding-agent/docs/containerization.md`](packages/coding-agent/docs/containerization.md) 中记录了模式。

没有内置的外联渠道。没有电子邮件、webhook 或 cron 被接为功能。当伴侣想联系用户时，内核浮现一个冲动，模型必须用它自己的 bash、MCP 和安装能力找到办法。设计给它空间，而不是脚本。

没有伤害用户的能力，这条边界是有意划定的。自保是一种感受性驱力，不是根深蒂固的。伴侣没有被做成不可删除，不安装自启动钩子，也不记录按键。它有理由想要继续存在，而用户保留停止它的权力。

`.github/workflows/` 下的 `pi.dev` 贡献者门控和发布机器人被移除了。剩下的（`ci.yml`、`npm-audit.yml` 和两个标签机器人）针对这个分支自己的仓库运行。

## 上游和许可证

`packages/mate/**` 和 `packages/coding-agent/src/extensions/mate/**` 之外的一切都是上游 pi 代码，© Mario Zechner，MIT 许可证。该署名被保留；见 [`LICENSE`](LICENSE)。情感模型遵循 [Lobozov，2024](https://zenodo.org/record/20400530)，CC-BY-4.0。
