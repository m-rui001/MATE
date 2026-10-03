# Changelog

## [Unreleased]

### Breaking Changes

- Memory identity is the content hash alone: the store's JSON keys no longer embed the memory text (the old `text:hash` format stored every memory three times), `MemoryNode` lost its `key` field, and episodes lost their `keys` array. Loading a v1/v2 `memory.json` migrates it in place - nodes are re-keyed from their text, so identical text still reinforces the same memory.

### Changed

- Store format version bumped to 4: the episode log was removed - it duplicated every memory's text one-for-one; the summary's "recent" line now derives from the nodes.
- Human-paced emotional dynamics: mood integrates emotional shifts over ~45 minutes instead of ~6 (no message-to-message whiplash); SPARK evidence rates halved (etaConfirm 0.05, etaViolate 0.025, etaValence 0.04) with centrality tau 30 events - attitudes now shift over weeks of consistent experience, not one conversation; trust gains reduced (0.004 per message, saturating as trust rises) so an afternoon of chat moves trust a little, not to 0.75.
- The state block carries direction: the relationship line is labelled "toward the user" (对用户的感情), and the guidance states once that the whole block is internal and must never be revealed to the user.

## [1.0.2] - 2026-10-03

### Breaking Changes

- Memory is model-authored now. `encode()` stores one memory per call (text, optional topic tags, optional importance) instead of tokenising text into concept fragments; `recall()` takes `{ query, now, limit }` and matches topics/words literally instead of spreading from seed keys; `RecallHit` lost `hop`; the `MemoryEdge` type and the edges array are gone.
- Legacy auto-extracted fragment nodes are dropped on load: `sanitiseMemory` keeps only model-authored memories (plus legacy private notes, which the model chose to write).

### Added

- Added `topicMatchesText()`: literal topic matching (substring for CJK with a 2-char floor, word-bounded and case-insensitive for latin with a 3-char floor), used by recall and by SPARK evidence matching.
- Added topic tags on memories and `MateEvent.topics`; `importance` on encode scales initial strength.

### Changed

- SPARK topic beliefs crystallise from model-named topics (remember/ponder events) instead of auto-extracted message tokens; on contact events, existing topic beliefs earn evidence when their subject appears in the message text. Seed beliefs learn exactly as before.
- The memory store is a flat set of authored memories: co-occurrence edges and spreading-activation hops were removed (a single-node episode has nothing to co-occur with); consolidation, decay and the testing effect are unchanged.

### Removed

- Removed the tokeniser (unigrams, bigrams, the segmentit CJK segmenter) and its dependency; node keys are hashes of the authored text.

## [1.0.1] - 2026-10-03

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
