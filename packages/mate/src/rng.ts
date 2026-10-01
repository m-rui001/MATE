/**
 * Deterministic randomness.
 *
 * The kernel must be reproducible: the same event sequence and the same seed produce
 * bit-identical state. So no Math.random anywhere in the kernel. The PRNG state lives
 * inside MateState and advances deterministically.
 */

/** SplitMix32: small, fast, good enough for affective noise, fully deterministic. */
export function nextRandom(seed: number): { value: number; seed: number } {
	let z = (seed + 0x9e3779b9) | 0;
	z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
	z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
	z ^= z >>> 15;
	// value in [0,1)
	return { value: (z >>> 0) / 4294967296, seed: (seed + 0x9e3779b9) | 0 };
}

/** Draw n uniform values, threading the seed. */
export function drawMany(seed: number, n: number): { values: number[]; seed: number } {
	const values: number[] = [];
	let s = seed;
	for (let i = 0; i < n; i++) {
		const r = nextRandom(s);
		values.push(r.value);
		s = r.seed;
	}
	return { values, seed: s };
}

/** Standard normal via Box-Muller, from two uniforms. */
export function gaussian(u1: number, u2: number): number {
	const r = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-12)));
	return r * Math.cos(2 * Math.PI * u2);
}

/** Draw one N(0, sigma) sample, threading the seed. */
export function drawNormal(seed: number, sigma: number): { value: number; seed: number } {
	const { values, seed: s2 } = drawMany(seed, 2);
	return { value: gaussian(values[0], values[1]) * sigma, seed: s2 };
}

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = (x: number): number => clamp(x, 0, 1);
export const clampPad = (x: number): number => clamp(x, -1, 1);
