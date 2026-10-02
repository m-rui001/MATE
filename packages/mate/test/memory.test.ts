/**
 * Memory invariants. These tests target the FORGETTING model specifically — the balance the user
 * asked about ("遗忘和记忆的关系"). Four properties have to hold, and three of them were wrong in the
 * first version of this module:
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
	tokenise,
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
	it("a seed node's score is dominated by its effective (time-decayed) strength", () => {
		// Before the fix, seeds added BOTH a raw-strength term AND a separate recencyWeight term,
		// so a stale node could keep ranking high purely because of the additive recency — a mild
		// form of the same problem consolidate was fixing. Now the score is activation-only.
		const fresh = neutral("fresh", 0.35, 0);
		const g = graphOf([fresh]);
		const hits = recall(g, { seeds: ["fresh"], now: 0 });
		expect(hits[0].score).toBeCloseTo(0.35 * 0.6 + 0 * 0.4, 5);
		// Advance a long time — the same recall on the same graph now yields a much lower score,
		// because time actually reduces what the node contributes.
		const stale = recall(g, { seeds: ["fresh"], now: 20 * DAY });
		expect(stale[0].score).toBeLessThan(0.02);
	});
});

describe("memory: tokenise + encode basics (unchanged guarantees)", () => {
	it("is deterministic and case-insensitive", () => {
		const a = tokenise("Cold Coffee");
		const b = tokenise("cold coffee");
		expect(a).toEqual(b);
		expect(a).toContain("cold");
		expect(a).toContain("coffee");
		expect(a).toContain("cold_coffee");
	});

	it("splits CJK into per-character unigrams", () => {
		const toks = tokenise("你好，世界");
		expect(toks).toContain("你");
		expect(toks).toContain("好");
		expect(toks).toContain("世");
		expect(toks).toContain("界");
	});

	it("encode folds a trace into nodes and edges with the episode's valence", () => {
		const g = encode(emptyMemory(), { text: "rainy day long walk", pad: { p: -0.6, a: 0.2, d: 0 }, t: 0 });
		expect(g.nodes[nodeKey("rainy")]).toBeDefined();
		expect(g.nodes[nodeKey("day")]).toBeDefined();
		// A co-occurrence edge should exist and carry a negative weight matching the episode.
		const e = g.edges.find(
			(x) => (x.a.includes("rainy") && x.b.includes("day")) || (x.b.includes("rainy") && x.a.includes("day")),
		);
		expect(e).toBeDefined();
		expect(e!.weight).toBeLessThan(0);
	});
});
