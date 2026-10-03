/**
 * Ambient types for `segmentit` — the package ships no TypeScript declarations. Only the surface the
 * tokeniser uses is declared, verified against segmentit 2.0.3, whose ESM build exposes
 * `Segment#doSegment` (the README's `cut` does not exist in the built output).
 */

declare module "segmentit" {
	/** One segmented token: the surface word plus segmentit's POS bitmask (unused here). */
	export interface SegmentedToken {
		/** Surface word, unmodified case. */
		w: string;
		/** POS tag bitmap, when the tagger assigned one. */
		p?: number;
	}

	/** Dictionary-backed maximum-probability Chinese segmenter. */
	export class Segment {
		/** Split `text` into word tokens. Deterministic for a given dictionary. */
		doSegment(text: string): SegmentedToken[];
	}

	/** Load segmentit's bundled default dictionaries into the segmenter and return it. */
	export function useDefault(segment: Segment): Segment;
}
