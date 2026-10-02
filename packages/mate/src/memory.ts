/**
 * Associative memory graph (NEXUS-style).
 *
 * Why this exists: the previous kernel had affect but no episodic memory. Every "thought" was
 * generated purely from mood + drives, which meant the companion could FEEL something without ever
 * having a specific thing to feel it ABOUT. The user's requirement — "为了像人我认为还是要把图记忆
 * 加上去" — is exactly this: memory, not just mood, should drive thinking.
 *
 * Design: a weighted, undirected graph of CONCEPT NODES linked by CO-OCCURRENCE edges. Nodes are
 * derived from a very small deterministic tokeniser (unigram + bigram, lowercase, unicode-word
 * characters, stop-list, length floor) — the same input text always yields the same node keys,
 * which keeps the whole kernel reproducible. Edges carry a positive/negative valence accumulated
 * from the affective context of the episodes that co-activated them.
 *
 * Operations:
 *   - encode:    fold an episodic trace (tokens + PAD + intent + text) into the graph.
 *   - recall:    spread activation from seeds (tokens and/or a PAD vector) and return the top-N
 *                nodes with their co-activation scores and hop-distance.
 *   - consolidate: called from the sleep path (kernel.sleepTransition) — decay strengths, prune
 *                below a floor, merge redundant nodes by key.
 *   - summary:   a stable, terse rendering of the graph's top nodes and edges for the CACHED
 *                system-prompt prefix (P5). Bounded; changes slowly.
 *
 * Determinism rules:
 *   - no Date.now() inside; every function takes explicit timestamps.
 *   - pruning ties broken by (strength desc, key asc) so the graph converges identically.
 *   - the tokeniser is pure (no regex lookahead, no locale-dependent case folding).
 *   - the seed field is threaded through any pseudo-randomness (currently none; kept for future
 *     drift / interpolation).
 *
 * Storage: a single JSON file `memory.json` in the state dir. The store.ts docstring reserved a
 * `memory/` directory + `memory.ts` module name; we keep that module name. Sharding can come
 * later if graphs get very large — until then a single file is atomic-written like state.json.
 */

/** A single concept node. */
export interface MemoryNode {
	/** Stable key derived from the surface token. Same token = same node, always. */
	key: string;
	/** Display form (the surface token, or a short label). Not used for identity. */
	label: string;
	/** Long-term strength in [0,1]. Reinforced on activation, decayed on consolidate. */
	strength: number;
	/** Short-term salience, decays fast; folds into recall scoring but not into the summary. */
	salience: number;
	/** Affective centroid from episodes this node appears in, PAD each [-1,1]. */
	pad: { p: number; a: number; d: number };
	/** How many episodes touched this node, coarse. */
	count: number;
	/** Last activation, epoch ms. */
	t: number;
	/** Optional sealed pointer (a sealed-entry id); the plaintext of this node is safe to expose,
	 * but if the companion decided to seal a memory, this points to it so recall can surface the
	 * hint without the text. */
	sealed?: string;
}

/** A weighted, undirected co-occurrence edge. Keys are stored canonically (a < b). */
export interface MemoryEdge {
	a: string;
	b: string;
	/** Edge weight in [-1, 1]. Positive = co-activated with matching valence; negative =
	 * co-activated while one side was high-arousal-negative and the other was low. */
	weight: number;
	/** Number of episodes that reinforced this edge. */
	count: number;
	/** Last co-activation, epoch ms. */
	t: number;
}

export interface MemoryGraph {
	version: number;
	/** Cap on total nodes so the graph is bounded; consolidation prunes the weakest beyond this. */
	maxNodes: number;
	nodes: Record<string, MemoryNode>;
	edges: MemoryEdge[];
	/** Recent episode snippets, ring buffer, each capped. Used as recall context and by the
	 * summary for the "recently" line. */
	episodes: Array<{ t: number; text: string; keys: string[]; pad: { p: number; a: number; d: number } }>;
	/** Monotonic counters for telemetry. */
	counters: { encoded: number; consolidations: number; pruned: number };
	/** Threaded PRNG state, reserved for future deterministic drift. */
	seed: number;
}

/** Tokenizer parameters. */
const MIN_TOKEN_LEN = 3;
const MAX_EPISODE_KEYS = 12;
const EPISODE_RING = 48;

/** A tiny stop-list: English high-frequency function words. Deliberately small — the point is not
 * "NLP-grade parsing", it is to avoid nodes for "the"/"and"/"you". Anything content-bearing passes. */
const STOP = new Set(
	(
		"the and for with that this your you're it's was were are you your they them their what when " +
		"how have has had not but can cant dont wont im id ve ll just like about into onto out off " +
		"then than so too yes yeah nope also well okay ok fine some any many much more most very"
	).split(" "),
);

/** Deterministic FNV-1a 32-bit hash, reused as node-key material. */
function hashKey(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

/**
 * The tokeniser. Lowercases, splits on non-word chars, keeps tokens of length >= 3 not in STOP,
 * and produces both unigrams and adjacent bigrams. Bigrams catch multi-word concepts ("rainy day",
 * "cold coffee") that a pure unigram bag would smear. Unicode word chars only (no letters flag → we
 * do not use `\w` because it would strip CJK; we use code-point category heuristics instead).
 */
export function tokenise(text: string): string[] {
	const lower = text.toLowerCase();
	// Split on anything that is not a Unicode letter, digit, or a CJK ideograph.
	// CJK is not space-delimited; for simplicity we treat every CJK char as its own token.
	const unigrams: string[] = [];
	const buf: string[] = [];
	const flush = (): void => {
		if (buf.length === 0) return;
		const w = buf.join("");
		buf.length = 0;
		if (w.length < MIN_TOKEN_LEN) return;
		if (STOP.has(w)) return;
		unigrams.push(w);
	};
	const isWord = (cp: number): boolean =>
		// ASCII letters/digits + Latin-1 letters + Greek/Cyrillic + general letters
		(cp >= 48 && cp <= 57) ||
		(cp >= 97 && cp <= 122) ||
		(cp >= 65 && cp <= 90) ||
		(cp >= 192 && cp <= 591) ||
		(cp >= 880 && cp <= 1023) ||
		(cp >= 1024 && cp <= 1279) ||
		cp === 95; // underscore
	const isCJK = (cp: number): boolean =>
		(cp >= 0x3040 && cp <= 0x30ff) || // kana
		(cp >= 0x3400 && cp <= 0x4dbf) || // ext A
		(cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
		(cp >= 0xf900 && cp <= 0xfaff) || // compat
		(cp >= 0x20000 && cp <= 0x2ebef); // ext B-F
	for (const ch of lower) {
		const cp = ch.codePointAt(0) ?? 0;
		if (isWord(cp)) buf.push(ch);
		else if (isCJK(cp)) {
			flush();
			// Each CJK char is its own unigram; bigrams handled below.
			unigrams.push(ch);
		} else flush();
	}
	flush();
	// Bigrams from adjacent unigrams.
	const out: string[] = [...unigrams];
	for (let i = 0; i + 1 < unigrams.length; i++) out.push(`${unigrams[i]}_${unigrams[i + 1]}`);
	return out;
}

/** Compute a stable node key from a token. Same token → same key. */
export function nodeKey(token: string): string {
	return `${token}:${hashKey(token)}`;
}

/** Canonicalise an edge to (a, b) with a < b, so lookups and dedup are stable. */
function canonEdge(a: string, b: string): [string, string] {
	return a < b ? [a, b] : [b, a];
}

/** Fresh, empty graph. */
export function emptyMemory(maxNodes = 400): MemoryGraph {
	return {
		version: 1,
		maxNodes,
		nodes: {},
		edges: [],
		episodes: [],
		counters: { encoded: 0, consolidations: 0, pruned: 0 },
		seed: 0x2545f491,
	};
}

interface EncodeArgs {
	text: string;
	pad: { p: number; a: number; d: number };
	t: number;
	/** Optional sealed-entry id to attach to episode keys (used for journal-style memories). */
	sealed?: string;
	/** Cap on how many distinct node keys this episode touches. */
	maxKeys?: number;
}

/**
 * Encode an episodic trace into the graph. Reinforces existing nodes and creates new ones for
 * unseen tokens; every co-occurring pair within this episode gets an edge reinforcement whose
 * weight leans on the episode's valence. Purely functional — returns a NEW graph.
 */
export function encode(g: MemoryGraph, args: EncodeArgs): MemoryGraph {
	const tokens = tokenise(args.text);
	if (tokens.length === 0) return g;
	const maxKeys = args.maxKeys ?? MAX_EPISODE_KEYS;

	const nodes = { ...g.nodes };
	const edgeMap = new Map<string, MemoryEdge>(g.edges.map((e) => [`${e.a}|${e.b}`, { ...e }]));

	// Deduplicate keys preserving first-seen order, cap at maxKeys.
	const seen = new Set<string>();
	const keys: string[] = [];
	for (const tok of tokens) {
		const k = nodeKey(tok);
		if (seen.has(k)) continue;
		seen.add(k);
		keys.push(k);
		if (keys.length >= maxKeys) break;
	}

	// Episode valence: PAD pleasantness is the simplest proxy for whether this contact was
	// pleasant or unpleasant. We fold that into edge weights so a node that repeatedly shows up
	// next to something bad accumulates a NEGATIVE association — which is exactly what a human
	// memory graph looks like.
	const valence = args.pad.p;

	for (const k of keys) {
		const label = k.split(":")[0] ?? k;
		const prev = nodes[k];
		if (prev) {
			// Exponential moving average on PAD; strength + salience bumped, capped.
			const alpha = 0.35;
			const pad = {
				p: prev.pad.p + (args.pad.p - prev.pad.p) * alpha,
				a: prev.pad.a + (args.pad.a - prev.pad.a) * alpha,
				d: prev.pad.d + (args.pad.d - prev.pad.d) * alpha,
			};
			nodes[k] = {
				...prev,
				strength: Math.min(1, prev.strength + 0.15),
				salience: Math.min(1, prev.salience + 0.3),
				pad,
				count: prev.count + 1,
				t: args.t,
				sealed: prev.sealed ?? args.sealed,
			};
		} else {
			nodes[k] = {
				key: k,
				label,
				strength: 0.35,
				salience: 0.6,
				pad: { ...args.pad },
				count: 1,
				t: args.t,
				sealed: args.sealed,
			};
		}
	}

	for (let i = 0; i < keys.length; i++) {
		for (let j = i + 1; j < keys.length; j++) {
			const [a, b] = canonEdge(keys[i], keys[j]);
			const ek = `${a}|${b}`;
			const existing = edgeMap.get(ek);
			if (existing) {
				// Blend edge valence from episode valence; the sign of the weight is the association's
				// affect, its magnitude is the co-activation frequency (saturating).
				const nextWeight = clampW(existing.weight * 0.7 + valence * 0.3);
				edgeMap.set(ek, { ...existing, weight: nextWeight, count: existing.count + 1, t: args.t });
			} else {
				edgeMap.set(ek, { a, b, weight: clampW(valence), count: 1, t: args.t });
			}
		}
	}

	const episodes = [...g.episodes, { t: args.t, text: trim(args.text, 120), keys, pad: { ...args.pad } }].slice(
		-EPISODE_RING,
	);
	return {
		...g,
		nodes,
		edges: Array.from(edgeMap.values()),
		episodes,
		counters: { ...g.counters, encoded: g.counters.encoded + 1 },
	};
}

/** Attach a sealed-entry id to a node by key. Returns the graph unchanged if the key isn't there. */
export function attachSealed(g: MemoryGraph, key: string, sealedId: string): MemoryGraph {
	const n = g.nodes[key];
	if (!n) return g;
	return { ...g, nodes: { ...g.nodes, [key]: { ...n, sealed: sealedId } } };
}

/**
 * Spreading activation from seed keys. Hop 1 = direct neighbours, hop 2 = neighbours of neighbours,
 * weighted lower. Deterministic; ties broken by (score desc, key asc).
 */
export interface RecallOptions {
	/** Seeds: node keys derived from tokens, or explicit keys. */
	seeds: string[];
	now: number;
	/** Max hop depth. Default 2. */
	depth?: number;
	/** Number of top results. Default 6. */
	limit?: number;
	/** Half-life for recency weighting. Default 48h. */
	recencyTauMs?: number;
}

export interface RecallHit {
	key: string;
	label: string;
	score: number;
	hop: number;
	pad: { p: number; a: number; d: number };
	strength: number;
	salience: number;
	sealed?: string;
}

export function recall(g: MemoryGraph, opts: RecallOptions): RecallHit[] {
	const depth = opts.depth ?? 2;
	const limit = opts.limit ?? 6;
	const tau = opts.recencyTauMs ?? 48 * 3_600_000;
	const scores = new Map<string, { score: number; hop: number }>();

	const seedSet = new Set(opts.seeds);
	for (const s of seedSet) {
		const n = g.nodes[s];
		if (!n) continue;
		const rec = recencyWeight(n.t, opts.now, tau);
		scores.set(s, { score: n.strength * 0.5 + n.salience * 0.5 + rec * 0.3, hop: 0 });
	}

	// Hop 1.
	const hop1 = new Map<string, number>();
	for (const [a, b] of neighbourPairs(g)) {
		if (!seedSet.has(a) && !seedSet.has(b)) continue;
		const src = seedSet.has(a) ? a : b;
		const dst = src === a ? b : a;
		if (seedSet.has(dst)) continue;
		const edge = edgeFor(g, src, dst);
		if (!edge) continue;
		const n = g.nodes[dst];
		if (!n) continue;
		const contribution = Math.abs(edge.weight) * (n.strength * 0.5 + n.salience * 0.5);
		hop1.set(dst, (hop1.get(dst) ?? 0) + contribution);
	}
	for (const [k, v] of hop1) {
		if (v <= 0) continue;
		const n = g.nodes[k];
		const rec = recencyWeight(n.t, opts.now, tau);
		const s = v * 0.7 + rec * 0.15;
		const prev = scores.get(k);
		if (!prev || s > prev.score) scores.set(k, { score: s, hop: 1 });
	}

	// Hop 2 (from hop-1 hits only, if depth >= 2).
	if (depth >= 2) {
		const hop1Keys = new Set(hop1.keys());
		const hop2 = new Map<string, number>();
		for (const [a, b] of neighbourPairs(g)) {
			const src = hop1Keys.has(a) ? a : hop1Keys.has(b) ? b : undefined;
			if (!src) continue;
			const dst = src === a ? b : a;
			if (seedSet.has(dst) || hop1Keys.has(dst)) continue;
			const edge = edgeFor(g, src, dst);
			if (!edge) continue;
			const srcScore = hop1.get(src) ?? 0;
			const n = g.nodes[dst];
			if (!n) continue;
			const contribution = srcScore * Math.abs(edge.weight) * 0.5 * (n.strength * 0.5 + n.salience * 0.5);
			hop2.set(dst, (hop2.get(dst) ?? 0) + contribution);
		}
		for (const [k, v] of hop2) {
			if (v <= 0) continue;
			const prev = scores.get(k);
			if (prev && prev.score >= v) continue;
			scores.set(k, { score: v, hop: 2 });
		}
	}

	return Array.from(scores.entries())
		.map(([key, s]) => {
			const n = g.nodes[key];
			return {
				key,
				label: n?.label ?? key,
				score: s.score,
				hop: s.hop,
				pad: n?.pad ?? { p: 0, a: 0, d: 0 },
				strength: n?.strength ?? 0,
				salience: n?.salience ?? 0,
				sealed: n?.sealed,
			};
		})
		.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1))
		.slice(0, limit);
}

/**
 * Consolidate. Called from the sleep path (once per sleep window) and on boot after catch-up.
 *  - Nodes: strength *= 0.98, salience *= 0.7 (short-term decays faster), age them toward zero.
 *  - Edges: weight *= 0.97, drop below a magnitude floor.
 *  - Prune: nodes below a strength floor or over maxNodes (weakest first).
 */
export function consolidate(g: MemoryGraph): MemoryGraph {
	const nodes: Record<string, MemoryNode> = {};
	for (const [k, n] of Object.entries(g.nodes)) {
		const strength = n.strength * 0.98;
		const salience = n.salience * 0.7;
		if (strength < 0.08) continue; // below floor: drop entirely
		nodes[k] = { ...n, strength, salience };
	}
	// Cap by maxNodes, weakest first.
	const keys = Object.keys(nodes);
	if (keys.length > g.maxNodes) {
		const drop = keys
			.sort((a, b) => nodes[a].strength - nodes[b].strength || (a < b ? -1 : 1))
			.slice(0, keys.length - g.maxNodes);
		for (const k of drop) delete nodes[k];
	}
	const edges: MemoryEdge[] = [];
	for (const e of g.edges) {
		if (!nodes[e.a] || !nodes[e.b]) continue;
		const weight = e.weight * 0.97;
		if (Math.abs(weight) < 0.05) continue;
		edges.push({ ...e, weight });
	}
	const prunedDelta = Object.keys(g.nodes).length - Object.keys(nodes).length;
	return {
		...g,
		nodes,
		edges,
		counters: {
			...g.counters,
			consolidations: g.counters.consolidations + 1,
			pruned: g.counters.pruned + Math.max(0, prunedDelta),
		},
	};
}

/**
 * A terse, STABLE rendering for the cached system-prompt prefix. Deliberately small and slow to
 * change so prompt caching holds. Emits: top N nodes by strength, their top edges (as "a ~ b"),
 * and one line for the most recent episode. Not the same thing as `recall` — recall is per-turn
 * and volatile; the summary is per-forever and lives in the cacheable prefix.
 */
export function summary(g: MemoryGraph, opts: { nodes?: number; edges?: number; maxChars?: number } = {}): string {
	const topN = opts.nodes ?? 12;
	const topE = opts.edges ?? 10;
	const nodeKeys = Object.values(g.nodes)
		.sort((a, b) => b.strength - a.strength || (a.key < b.key ? -1 : 1))
		.slice(0, topN)
		.map((n) => `${n.label}:${n.strength.toFixed(2)}`);
	const edgeLines = [...g.edges]
		.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || (a.a < b.a ? -1 : 1))
		.slice(0, topE)
		.map((e) => {
			const la = g.nodes[e.a]?.label ?? e.a;
			const lb = g.nodes[e.b]?.label ?? e.b;
			const sign = e.weight < 0 ? "~" : "+";
			return `${la} ${sign}${Math.abs(e.weight).toFixed(2)} ${lb}`;
		});
	const lines: string[] = [];
	if (nodeKeys.length) lines.push(`nodes: ${nodeKeys.join(", ")}`);
	if (edgeLines.length) lines.push(`ties: ${edgeLines.join(" | ")}`);
	const recent = g.episodes[g.episodes.length - 1];
	if (recent) lines.push(`recent: ${trim(recent.text, 90)}`);
	if (lines.length === 0) return "";
	const body = `<mate-memory>\n${lines.join("\n")}\n</mate-memory>`;
	const max = opts.maxChars ?? 900;
	return body.length <= max ? body : `${body.slice(0, max - 14)}\n…\n</mate-memory>`;
}

/** The top-k node keys for a mood-driven "what has been on my mind" seed, ignoring text input. */
export function topNodes(g: MemoryGraph, now: number, k = 3): string[] {
	return Object.values(g.nodes)
		.sort(
			(a, b) =>
				b.strength * 0.6 +
					recencyWeight(a.t, now, 72 * 3_600_000) * 0.4 -
					(b.strength * 0.6 + recencyWeight(b.t, now, 72 * 3_600_000) * 0.4) || (a.key < b.key ? -1 : 1),
		)
		.slice(0, k)
		.map((n) => n.key);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function recencyWeight(t: number, now: number, tau: number): number {
	const dt = Math.max(0, now - t);
	return Math.exp(-dt / tau);
}

function clampW(x: number): number {
	if (x > 1) return 1;
	if (x < -1) return -1;
	return x;
}

function trim(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function* neighbourPairs(g: MemoryGraph): Generator<[string, string]> {
	for (const e of g.edges) yield [e.a, e.b];
}

const edgeIndex = new WeakMap<MemoryGraph, Map<string, MemoryEdge>>();
function edgeFor(g: MemoryGraph, a: string, b: string): MemoryEdge | undefined {
	let idx = edgeIndex.get(g);
	if (!idx) {
		idx = new Map(g.edges.map((e) => [`${e.a}|${e.b}`, e]));
		edgeIndex.set(g, idx);
	}
	const [x, y] = canonEdge(a, b);
	return idx.get(`${x}|${y}`);
}

/** Repair a loaded graph; anything malformed falls back to empty rather than crashing boot. */
export function sanitiseMemory(raw: unknown): MemoryGraph {
	if (!raw || typeof raw !== "object") return emptyMemory();
	const r = raw as Partial<MemoryGraph>;
	if (typeof r.maxNodes !== "number" || r.maxNodes <= 0) return emptyMemory();
	const nodes: Record<string, MemoryNode> = {};
	if (r.nodes && typeof r.nodes === "object") {
		for (const [k, v] of Object.entries(r.nodes)) {
			if (!v || typeof v !== "object") continue;
			const n = v as Partial<MemoryNode>;
			if (typeof n.strength !== "number" || typeof n.salience !== "number") continue;
			nodes[k] = {
				key: typeof n.key === "string" ? n.key : k,
				label: typeof n.label === "string" ? n.label : (k.split(":")[0] ?? k),
				strength: n.strength,
				salience: n.salience,
				pad: {
					p: typeof n.pad?.p === "number" ? n.pad.p : 0,
					a: typeof n.pad?.a === "number" ? n.pad.a : 0,
					d: typeof n.pad?.d === "number" ? n.pad.d : 0,
				},
				count: typeof n.count === "number" ? n.count : 1,
				t: typeof n.t === "number" ? n.t : 0,
				sealed: typeof n.sealed === "string" ? n.sealed : undefined,
			};
		}
	}
	const edges: MemoryEdge[] = Array.isArray(r.edges)
		? r.edges
				.filter((e) => e && typeof e.a === "string" && typeof e.b === "string" && typeof e.weight === "number")
				.map((e) => ({ ...e }))
		: [];
	const episodes = Array.isArray(r.episodes)
		? r.episodes.filter((e) => e && typeof e.t === "number" && typeof e.text === "string" && Array.isArray(e.keys))
		: [];
	return {
		version: typeof r.version === "number" ? r.version : 1,
		maxNodes: r.maxNodes,
		nodes,
		edges,
		episodes,
		counters:
			r.counters && typeof r.counters === "object"
				? { ...emptyMemory().counters, ...r.counters }
				: emptyMemory().counters,
		seed: typeof r.seed === "number" ? r.seed : 0x2545f491,
	};
}
