/**
 * Memory invariants. These tests target the FORGETTING model specifically — the remembering vs
 * forgetting balance this module exists to strike. Four properties have to hold, and three of them
 * were wrong in the first version of this module:
 *   1. `topNodes` actually reads strength (regression against a bug where the comparator paired one
 *      node's recency with the other's strength, silently dropping strength from the score).
 *   2. `consolidate` is TIME-AWARE: a longer offline gap costs more forgetting than a shorter one,
 *      for identical stored content. (Previously: a fixed `*0.98` per call, so a week and an hour
 *      looked the same.)
 *   3. Emotional charge SLOWS forgetting, not just adds a retrieval bonus. (ACT-R's power law + the
 *      synaptic-homeostasis literature agree: what mattered is what survives downscaling.)
 *   4. The testing effect: a repeatedly-retrieved memory persists; an unrehearsed one of the same
 *      stored strength fades and eventually prunes.
 */

import { describe, expect, it } from "vitest";
import {
	consolidate,
	emptyMemory,
	encode,
	type MemoryGraph,
	type MemoryNode,
	nodeKey,
	recall,
	rehearse,
	sanitiseMemory,
	summary,
	topicMatchesText,
	topNodes,
} from "../src/memory.ts";

const DAY = 86_400_000;

/** Build a graph containing exactly the given nodes and no edges, for focused forgetting tests. */
function graphOf(nodes: MemoryNode[]): MemoryGraph {
	const g = emptyMemory(400);
	const map: Record<string, MemoryNode> = {};
	for (const n of nodes) map[n.key] = n;
	return { ...g, nodes: map };
}

/** A neutral node: no emotional charge, so its `protectedTau` equals the base STRENGTH_TAU. */
function neutral(key: string, strength: number, t: number): MemoryNode {
	return { key, label: key, strength, salience: 0, pad: { p: 0, a: 0, d: 0 }, count: 1, t };
}

/** A charged node: high |p| gives it the full importance boost on its decay time constant. */
function charged(key: string, strength: number, t: number): MemoryNode {
	return { key, label: key, strength, salience: 0, pad: { p: 1, a: 0, d: 0 }, count: 1, t };
}

describe("memory: topNodes reads strength (regression)", () => {
	it("prefers a strong older node over a weak fresher one when activation differs", () => {
		// The buggy comparator used `recencyWeight(a.t) - recencyWeight(b.t)` while ignoring the
		// strength terms entirely, so a weak-but-fresh node would beat a strong-but-older one.
		// Fixed version ranks by `activation` (time-decayed strength + a slice of salience), so
		// a strength=0.9 node and a strength=0.1 node at comparable times must order 0.9 first.
		// Set t the same so recency is not the tie-breaker at all — pure strength signal.
		const strong = neutral("strong", 0.9, 0);
		const weak = neutral("weak", 0.1, 0);
		const g = graphOf([weak, strong]);
		const top = topNodes(g, 0, 2);
		expect(top[0]).toBe("strong");
		expect(top[1]).toBe("weak");
	});

	it("uses time-decayed strength, so a much older strong node can lose to a fresh weaker one", () => {
		// This is the OTHER direction the old bug couldn't express: forgetting actually shifts the
		// ranking. A node stored at 0.5 five half-lives ago reads lower than one stored at 0.4 that
		// was refreshed just now.
		const oldStrong = neutral("old_strong", 0.5, 0);
		const freshWeak = neutral("fresh_weak", 0.4, 15 * DAY);
		// Consolidate would bank the old node's decay into stored strength, but topNodes runs on
		// the live graph too. At now=15*DAY the old one's effective strength is 0.5*exp(-3) ≈ 0.025,
		// while the fresh one is 0.4*exp(0) = 0.4. So fresh_weak must win.
		const g = graphOf([oldStrong, freshWeak]);
		const top = topNodes(g, 15 * DAY, 2);
		expect(top[0]).toBe("fresh_weak");
	});
});

describe("memory: consolidate is time-aware", () => {
	it("a 2-day gap costs less forgetting than a 20-day gap for identical stored content", () => {
		// Same starting node, only the elapsed time differs. The old fixed `*0.98` model returned
		// the same strength in both cases — this asserts they now differ, in the correct direction.
		const make = (now: number) => consolidate(graphOf([neutral("x", 0.35, 0)]), now);
		const after2d = make(2 * DAY);
		const after20d = make(20 * DAY);
		// 2 days at tau=5d: strength ≈ 0.35*exp(-0.4) ≈ 0.234 → survives the 0.08 floor.
		expect(after2d.nodes["x"]).toBeDefined();
		expect(after2d.nodes["x"].strength).toBeGreaterThan(0.15);
		expect(after2d.nodes["x"].strength).toBeLessThan(0.35);
		// 20 days at tau=5d: strength ≈ 0.35*exp(-4) ≈ 0.0064 → below floor, pruned. This IS the
		// forgetting the whole model exists to produce.
		expect(after20d.nodes["x"]).toBeUndefined();
	});

	it("resets the decay clock so the same interval is not decayed twice", () => {
		// Consolidate at t=2d, then again at t=4d. Two 2-day passes should cost roughly the same as
		// one 4-day pass — otherwise the "banked decay" idea is wrong and we'd double-count.
		const g = graphOf([neutral("x", 0.35, 0)]);
		const twoPass = consolidate(consolidate(g, 2 * DAY), 4 * DAY);
		const onePass = consolidate(g, 4 * DAY);
		// Exponential decay is a semigroup, so this should be near-identical (small drift only from
		// the geometric-mean edge rule, which is irrelevant here since there are no edges).
		expect(twoPass.nodes["x"].strength).toBeCloseTo(onePass.nodes["x"]!.strength, 4);
	});
});

describe("memory: emotional charge slows forgetting", () => {
	it("a highly-charged node survives a gap that prunes an identical-strength neutral one", () => {
		// protectedTau multiplies the base tau by up to (1 + IMPORTANCE_BOOST*charge) = 4×. So a
		// 20-day gap that prunes a neutral 0.35 node leaves a charged one at 0.35*exp(-20/20) ≈ 0.129
		// — above the 0.08 floor.
		const now = 20 * DAY;
		const neutralOut = consolidate(graphOf([neutral("n", 0.35, 0)]), now);
		const chargedOut = consolidate(graphOf([charged("c", 0.35, 0)]), now);
		expect(neutralOut.nodes["n"]).toBeUndefined();
		expect(chargedOut.nodes["c"]).toBeDefined();
		expect(chargedOut.nodes["c"].strength).toBeGreaterThan(0.08);
	});
});

describe("memory: the testing effect (rehearse)", () => {
	it("repeated retrieval keeps a memory alive that an unrehearsed equal would fade past", () => {
		// Simulate: a companion sees the same concept surface from recall every ~2 days across a
		// month. Each surfacing calls `rehearse`, which bumps strength AND resets the decay clock.
		// The control node gets the same number of "days passing" but no retrieval reinforcement, so
		// it must fall below the prune floor.
		const g0 = graphOf([neutral("kept", 0.35, 0), neutral("lost", 0.35, 0)]);
		let g = g0;
		for (let step = 1; step <= 15; step++) {
			const now = step * 2 * DAY;
			g = { ...g, nodes: { ...g.nodes } };
			// Only "kept" is retrieved on this beat — that is what a real recall side-effect does.
			g.nodes["kept"] = {
				...g.nodes["kept"],
				strength: Math.min(1, g.nodes["kept"].strength + 0.06),
				salience: Math.min(1, g.nodes["kept"].salience + 0.2),
				t: now,
			};
			g = consolidate(g, now);
			// `lost` may already have been pruned by now; `kept` must survive every single pass.
			expect(g.nodes["kept"]).toBeDefined();
		}
		// And by month's end `lost` is gone while `kept` is still there — the whole point of
		// "what do I keep vs. what do I forget."
		expect(g.nodes["lost"]).toBeUndefined();
		expect(g.nodes["kept"].strength).toBeGreaterThan(0.08);
	});

	it("rehearse is a no-op for empty input and for unknown keys", () => {
		const g = graphOf([neutral("x", 0.5, 0)]);
		expect(rehearse(g, [], 0)).toBe(g);
		const out = rehearse(g, ["not_here"], 10);
		expect(out.nodes["x"].strength).toBe(0.5);
	});
});

describe("memory: recall scoring has no double-counted recency", () => {
	it("a topic-matched memory scores by its effective (time-decayed) strength", () => {
		// The score is activation-only (time-decayed strength plus a slice of salience), so a fresh
		// memory reads exactly its activation, and time actually reduces what it contributes.
		const fresh: MemoryNode = {
			...neutral("fresh", 0.35, 0),
			topics: ["fresh"],
		};
		const g = graphOf([fresh]);
		const hits = recall(g, { query: "tell me about the fresh thing", now: 0 });
		expect(hits).toHaveLength(1);
		expect(hits[0].score).toBeCloseTo(0.35 * 0.6 + 0 * 0.4, 5);
		// Advance a long time — the same recall now returns nothing at all, because the memory has
		// decayed below retrieval range. Time is the forgetting mechanism, not a ranking bonus.
		const stale = recall(g, { query: "tell me about the fresh thing", now: 20 * DAY });
		expect(stale).toHaveLength(0);
	});

	it("matches by topic (strong) and by content words of the memory itself (weaker)", () => {
		const tagged: MemoryNode = { ...neutral("tagged", 0.5, 0), topics: ["面试"] };
		const untagged: MemoryNode = {
			...neutral("untagged", 0.5, 0),
			label: "she is preparing a job interview",
		};
		const g = graphOf([tagged, untagged]);
		// The topic hits with factor 1.0, the label-word hit with a lower factor, so the tagged
		// memory ranks first on equal strength.
		const hits = recall(g, { query: "面试感觉很紧张, thinking about my interview", now: 0 });
		expect(hits[0].key).toBe("tagged");
		expect(hits).toHaveLength(2);
		// A latin topic never matches inside another word.
		expect(topicMatchesText("work", "I have too much network traffic")).toBe(false);
	});
});

describe("memory: topics match literally, no tokeniser", () => {
	it("CJK topics are substrings; single characters are too generic and never match", () => {
		expect(topicMatchesText("面试", "明天要去面试，有点紧张")).toBe(true);
		expect(topicMatchesText("面试", "今天天气不错")).toBe(false);
		// 好 appears inside 好吗/好的/爱好 — a one-character topic would match everywhere.
		expect(topicMatchesText("好", "好吗")).toBe(false);
		expect(topicMatchesText("好", "爱好音乐")).toBe(false);
	});

	it("latin topics are word-bounded and case-insensitive", () => {
		expect(topicMatchesText("Work", "how is work going")).toBe(true);
		expect(topicMatchesText("work", "the network is down")).toBe(false);
		expect(topicMatchesText("cat", "CAT")).toBe(true);
		expect(topicMatchesText("ab", "ablation")).toBe(false); // below the length floor
	});
});

describe("memory: encode stores one authored memory", () => {
	it("the whole text is the memory; re-encoding the same text reinforces it", () => {
		const text = "they are preparing for a job interview next week";
		let g = encode(emptyMemory(), { text, pad: { p: -0.2, a: 0.4, d: 0 }, t: 0 });
		expect(Object.keys(g.nodes)).toHaveLength(1);
		const key = nodeKey(text);
		expect(g.nodes[key]).toBeDefined();
		expect(g.nodes[key].count).toBe(1);
		// The moment's valence is remembered as the memory's affective centroid.
		expect(g.nodes[key].pad.p).toBe(-0.2);

		g = encode(g, { text: `${text} `, pad: { p: 0.4, a: 0, d: 0 }, t: 1_000 });
		expect(Object.keys(g.nodes)).toHaveLength(1);
		expect(g.nodes[key].count).toBe(2);
		expect(g.nodes[key].strength).toBeGreaterThan(0.4);
		expect(g.nodes[key].pad.p).toBeGreaterThan(-0.2); // EMA moved toward the new valence
	});

	it("importance scales the initial strength, topics are stored capped and deduplicated", () => {
		const g = encode(emptyMemory(), {
			text: "core memory",
			pad: { p: 0, a: 0, d: 0 },
			t: 0,
			topics: ["core", "core", "", "extra", "one", "two"],
			importance: 1,
		});
		const node = g.nodes[nodeKey("core memory")];
		expect(node.strength).toBeCloseTo(0.75, 5); // 0.25 + 0.5 * 1
		// Deduplicated, empties dropped, capped at 3.
		expect(node.topics).toEqual(["core", "extra", "one"]);
		// Default importance is 0.3.
		const plain = encode(emptyMemory(), { text: "a note", pad: { p: 0, a: 0, d: 0 }, t: 0 });
		expect(plain.nodes[nodeKey("a note")].strength).toBeCloseTo(0.4, 5);
	});
});

describe("memory: private thoughts", () => {
	it("keeps private memories out of the summary but reachable via recall", () => {
		// A private note is an ordinary memory — it encodes, reinforces and recalls like any other —
		// but `summary` is the user-visible block, so its label must never render there.
		let g = encode(emptyMemory(), { text: "whisper", pad: { p: 0, a: 0, d: 0 }, t: 0, private: true });
		g = encode(g, { text: "rainbow", pad: { p: 0, a: 0, d: 0 }, t: 1 });
		expect(g.nodes[nodeKey("whisper")]).toBeDefined();
		const s = summary(g);
		expect(s).not.toContain("whisper");
		expect(s).toContain("rainbow");
		// Private means unrendered, not forgotten: recall still finds it.
		const hits = recall(g, { query: "a quiet whisper", now: 1 });
		expect(hits.some((h) => h.label === "whisper")).toBe(true);
	});
});

describe("memory: legacy auto-extracted fragments are dropped on load", () => {
	it("sanitiseMemory keeps only model-authored memories (legacy private notes stay)", () => {
		const legacyFragment = neutral("感觉:abc", 0.5, 0); // no origin: tokeniser-era node
		const legacyPrivate: MemoryNode = { ...neutral("p", 0.5, 0), private: true };
		const authored: MemoryNode = { ...neutral("a", 0.5, 0), origin: "model" as const };
		const raw = {
			version: 1,
			maxNodes: 400,
			nodes: { f: legacyFragment, p: legacyPrivate, a: authored },
			episodes: [],
			counters: { encoded: 3, consolidations: 0, pruned: 0 },
			seed: 0,
		};
		const g = sanitiseMemory(raw);
		expect(g.nodes["f"]).toBeUndefined(); // the noise this rewrite exists to remove
		expect(g.nodes["p"]).toBeDefined(); // the model chose to keep it
		expect(g.nodes["p"].origin).toBe("model");
		expect(g.nodes["a"]).toBeDefined();
	});
});
