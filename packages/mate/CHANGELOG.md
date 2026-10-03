# Changelog

## [Unreleased]

### Added

- Added SPARK, the cognitive autopoietic loop (paper section 3.9): a bounded belief store seeded with two core beliefs, Eq. 24 perception modulation (`valence x strength x 0.15 x dsanity`), asymmetric evidence learning (confirmation bias per Lefebvre et al. 2022), a rigidity damper against runaways, and closed-form confidence decay so beliefs are precarious without evidence. Beliefs surface as a cached `beliefs:` prompt line.
- Added derived boredom: `boredomOf()` computes `predictability x (1 - thoughtSaturation) x (0.4 + 0.6 * extraversion) x idleGate` from a surprise EMA and topic-habituation saturation (Schmidhuber 1991, Darling 2023, Yu et al. 2019) instead of storing boredom as a drive.
- Added private-thought encoding: memory-graph nodes and episodes can be flagged `private`; they participate in recall but are excluded from the user-visible summary.
- Added dictionary-based Chinese word segmentation (`segmentit`, the jieba algorithm) so CJK memory nodes are real words like 你好/世界 instead of per-character unigrams; grammatical particles are dropped, cross-language bigrams kept.

### Changed

- The perception modulation is applied in the confirmatory direction (evidence agreeing with a belief is amplified, conflicting evidence dampened) rather than the paper's literal multiplication, which amplified disconfirming evidence.

### Removed

- Removed the `boredom` and `selfPreservation` fields from `Drives`; boredom is derived, self-preservation was dropped as an orphan with no counterpart in the paper's 8 modules.
- Removed the encrypted sealed self (`secret.ts`, `sealed.json`, machine-bound keys). Private thoughts are ordinary private-flagged memories.

### Fixed

- Fixed `updateDrives` state migration spreading stale drive keys from old `state.json` files back into new states; drives are now picked key-by-key on load.
- Fixed belief confidence caging: updates clamp into `[0.05, 0.95]` instead of rescaling, which had silently capped confidence at 0.76.
- Fixed i18n test snapshots being timezone-dependent; the suite pins UTC.
