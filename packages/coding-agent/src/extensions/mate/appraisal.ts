/**
 * Cheap lexical appraisal: map inbound text to Plutchik activations WITHOUT an LLM call.
 *
 * The paper's pipeline spends one LLM call per message on appraisal (text -> emotion vector). That
 * is the single biggest avoidable token cost in a companion that exchanges many short messages, and
 * the user explicitly asked to minimise per-conversation token consumption. So the DEFAULT appraisal
 * is this deterministic keyword/valence pass: instant, free, and good enough to drive the
 * may-not-reply / mood decisions.
 *
 * The higher-fidelity path is the model's optional `feel` tool (see feel-tool.ts): when a message
 * actually matters, the model - which has just read it in full - reports a richer activation vector,
 * refining what this heuristic guessed. That way we pay for LLM appraisal only when it is worth it,
 * not on every "ok" and "lol".
 *
 * This is deliberately small. It is a first impression, not a reading.
 *
 * LANGUAGE: the LEXICON carries Chinese keywords too, because a zh companion receives zh messages.
 * Substring matching already covers CJK (no word boundaries needed). The `feel` tool remains the
 * high-fidelity path in either language; this table only decides how much the FIRST impression moves.
 */

import { EMOTIONS, type EmotionVector } from "@earendil-works/pi-mate";

/** Keyword -> emotion weight. Lowercased substring match; weights are per-hit, capped later. */
const LEXICON: Record<string, Partial<EmotionVector>> = {
	// joy
	haha: { joy: 0.5 },
	lol: { joy: 0.4 },
	lmao: { joy: 0.5 },
	"😂": { joy: 0.6 },
	"🙂": { joy: 0.3 },
	great: { joy: 0.4 },
	awesome: { joy: 0.5 },
	amazing: { joy: 0.6 },
	happy: { joy: 0.6 },
	glad: { joy: 0.4 },
	yay: { joy: 0.6 },
	excited: { joy: 0.4, anticipation: 0.4 },
	love: { joy: 0.5, trust: 0.3 },
	fun: { joy: 0.4 },
	nice: { joy: 0.3 },
	thanks: { joy: 0.3, trust: 0.3 },
	"thank you": { joy: 0.4, trust: 0.3 },
	// trust
	trust: { trust: 0.5 },
	"i believe": { trust: 0.4 },
	honestly: { trust: 0.2 },
	friend: { trust: 0.4, joy: 0.2 },
	proud: { trust: 0.4, joy: 0.3 },
	"you're right": { trust: 0.3 },
	agree: { trust: 0.25 },
	// fear
	scared: { fear: 0.7 },
	afraid: { fear: 0.6 },
	anxious: { fear: 0.5, sadness: 0.2 },
	worried: { fear: 0.5 },
	nervous: { fear: 0.5 },
	panic: { fear: 0.8 },
	terrified: { fear: 0.9 },
	creepy: { fear: 0.4, disgust: 0.3 },
	"don't leave": { fear: 0.5, sadness: 0.3 },
	// surprise
	wow: { surprise: 0.5 },
	whoa: { surprise: 0.5 },
	"no way": { surprise: 0.5 },
	"?!": { surprise: 0.4 },
	unexpected: { surprise: 0.5 },
	suddenly: { surprise: 0.3 },
	really: { surprise: 0.2 },
	// sadness
	sad: { sadness: 0.7 },
	lonely: { sadness: 0.6, fear: 0.2 },
	depressed: { sadness: 0.8 },
	cry: { sadness: 0.7 },
	crying: { sadness: 0.8 },
	miss: { sadness: 0.4 },
	"i miss you": { sadness: 0.5, trust: 0.2 },
	hurt: { sadness: 0.6, anger: 0.2 },
	tired: { sadness: 0.3 },
	exhausted: { sadness: 0.4 },
	hopeless: { sadness: 0.8 },
	empty: { sadness: 0.6 },
	grief: { sadness: 0.9 },
	// disgust
	disgust: { disgust: 0.7 },
	gross: { disgust: 0.6 },
	eww: { disgust: 0.6 },
	"🤢": { disgust: 0.7 },
	sick: { disgust: 0.3, sadness: 0.2 },
	repulsive: { disgust: 0.8 },
	// anger
	angry: { anger: 0.7 },
	mad: { anger: 0.6 },
	furious: { anger: 0.9 },
	hate: { anger: 0.7, disgust: 0.3 },
	annoyed: { anger: 0.5 },
	pissed: { anger: 0.8 },
	stupid: { anger: 0.5, disgust: 0.2 },
	"shut up": { anger: 0.6 },
	"fuck off": { anger: 0.8 },
	idiot: { anger: 0.6, disgust: 0.3 },
	// anticipation
	tomorrow: { anticipation: 0.4 },
	"can't wait": { anticipation: 0.6, joy: 0.3 },
	soon: { anticipation: 0.3 },
	plan: { anticipation: 0.3 },
	"looking forward": { anticipation: 0.6, joy: 0.3 },
	later: { anticipation: 0.2 },
	wonder: { anticipation: 0.2, surprise: 0.2 },
	"what if": { anticipation: 0.3, surprise: 0.2 },
	// ---- Chinese ----
	// Same weights as the English equivalents, so a 哈哈 and a haha land the same way.
	哈哈: { joy: 0.5 },
	呵呵: { joy: 0.2 },
	太好了: { joy: 0.5 },
	开心: { joy: 0.6 },
	高兴: { joy: 0.5 },
	喜欢: { joy: 0.4, trust: 0.2 },
	爱: { joy: 0.5, trust: 0.3 },
	好玩: { joy: 0.4 },
	不错: { joy: 0.3 },
	谢: { joy: 0.3, trust: 0.3 },
	辛苦: { joy: 0.2, trust: 0.3 },
	棒: { joy: 0.4 },
	信任: { trust: 0.5 },
	我相信: { trust: 0.4 },
	朋友: { trust: 0.4, joy: 0.2 },
	骄傲: { trust: 0.4, joy: 0.3 },
	你说得对: { trust: 0.3 },
	对对: { trust: 0.25 },
	害怕: { fear: 0.7 },
	怕: { fear: 0.5 },
	担心: { fear: 0.5 },
	紧张: { fear: 0.5 },
	慌: { fear: 0.6 },
	吓: { fear: 0.5 },
	别走: { fear: 0.5, sadness: 0.3 },
	哇: { surprise: 0.5 },
	天哪: { surprise: 0.6 },
	不会吧: { surprise: 0.5 },
	居然: { surprise: 0.4 },
	突然: { surprise: 0.3 },
	真的吗: { surprise: 0.3, anticipation: 0.2 },
	难过: { sadness: 0.7 },
	孤独: { sadness: 0.6, fear: 0.2 },
	一个人: { sadness: 0.4 },
	哭: { sadness: 0.7 },
	想你了: { sadness: 0.5, trust: 0.2 },
	难受: { sadness: 0.6, anger: 0.2 },
	累: { sadness: 0.3 },
	没意思: { sadness: 0.4 },
	空: { sadness: 0.4 },
	绝望: { sadness: 0.8 },
	恶心: { disgust: 0.7 },
	烦人: { disgust: 0.4, anger: 0.3 },
	生气: { anger: 0.7 },
	气死: { anger: 0.8 },
	恨: { anger: 0.7, disgust: 0.3 },
	烦: { anger: 0.5 },
	傻: { anger: 0.5, disgust: 0.2 },
	闭嘴: { anger: 0.6 },
	明天: { anticipation: 0.4 },
	等不及: { anticipation: 0.6, joy: 0.3 },
	马上: { anticipation: 0.3 },
	计划: { anticipation: 0.3 },
	期待: { anticipation: 0.6, joy: 0.3 },
	回头: { anticipation: 0.2 },
	好奇: { anticipation: 0.2, surprise: 0.2 },
	会不会: { anticipation: 0.3, surprise: 0.2 },
};

/** Question / request markers: raise intent, mild anticipation. CJK needs no word boundaries.
 * 吗 at the end is a genuine question particle; 呢 is not (它常作陈述语气), so only 呢 with a
 * question mark counts, and that already matches via the ？ rule. */
const QUESTION_RE =
	/\?\s*$|？\s*$|吗[？?]?\s*$|\b(why|what|how|when|where|who|can you|could you|would you|please)\b|为什么|怎么|如何|什么|哪里|谁|能不能|可不可以|可以吗|行吗|好吗|是不是|有没有|请问|帮我|麻烦/i;
const NEGATION_RE = /\b(not|no|never|don't|doesn't|isn't|aren't|won't)\b/i;
// A bare 不 would negate 不错 ("not bad" = good). Match the common multi-char negations instead.
const NEGATION_ZH_RE = /不太|不是|没有|不想|不开|不会|别|没人|无/;

export interface AppraisalResult {
	activations: Partial<EmotionVector>;
	/** Affective intensity 0..1, drives the unitary kick and character nudge. */
	intensity: number;
	intent: "chat" | "question" | "task";
	/** A rough affective weight (P1: distress/questions weigh more). Feeds replyInclination, which
	 * surfaces an advisory lean to the model — it no longer gates or drops the turn itself. */
	weight: number;
}

/**
 * Appraise one inbound message. Pure, synchronous, no LLM.
 */
export function appraise(text: string): AppraisalResult {
	const lower = text.toLowerCase();
	const activations = {} as EmotionVector;
	for (const e of EMOTIONS) activations[e] = 0;

	let hits = 0;
	for (const [kw, weights] of Object.entries(LEXICON)) {
		if (lower.includes(kw)) {
			hits++;
			for (const [e, w] of Object.entries(weights)) {
				const emo = e as keyof EmotionVector;
				activations[emo] = Math.min(1, activations[emo] + (w ?? 0));
			}
		}
	}

	// Negation flips a little valence: "not happy" / "不开心" nudges sadness rather than joy.
	const negated = NEGATION_RE.test(lower) || NEGATION_ZH_RE.test(text);
	if (negated && activations.joy > 0) {
		const moved = activations.joy * 0.6;
		activations.joy -= moved;
		activations.sadness = Math.min(1, activations.sadness + moved * 0.7);
	}

	// No lexical hit: fall back to a mild valence from punctuation/case so the state still moves.
	if (hits === 0) {
		const excl = (text.match(/!/g) ?? []).length;
		// Shouting detection needs CASE to mean something: `text === text.toUpperCase()` is trivially
		// true for CJK, which would make every Chinese sentence read as surprised. Requiring
		// text !== text.toLowerCase() guarantees at least one real uppercase Latin letter.
		const caps = text.length > 3 && text === text.toUpperCase() && text !== text.toLowerCase() ? 1 : 0;
		if (excl >= 2 || caps) activations.surprise = 0.3;
		if (QUESTION_RE.test(text)) activations.anticipation = Math.max(activations.anticipation, 0.25);
	}

	// Intent classification (feeds the effort model's INTENT_SCALE and respect accrual).
	let intent: AppraisalResult["intent"] = "chat";
	if (QUESTION_RE.test(text)) intent = "question";
	if (
		/\b(fix|write|build|run|install|create|make|edit|refactor|debug|implement|code|script|deploy)\b/i.test(lower) ||
		/修复|调试|重构|部署|安装|运行一下|跑一下|写一个|写个|创建|生成|实现|改一下|改代码|脚本/.test(text)
	) {
		intent = "task";
	}

	// Intensity: total activation, capped. Weight: intensity biased toward high-arousal/distress,
	// so a message that needs an answer pulls the reply decision up.
	let total = 0;
	for (const e of EMOTIONS) total += activations[e];
	const intensity = Math.min(1.5, total);
	const distress = activations.fear + activations.sadness + activations.anger;
	const weight = Math.min(1, total * 0.5 + distress * 0.4 + (intent === "question" ? 0.2 : 0));

	// Only keep channels that actually fired, to stay a Partial and keep the vector sparse.
	const out: Partial<EmotionVector> = {};
	for (const e of EMOTIONS) if (activations[e] > 0.001) out[e] = Math.round(activations[e] * 1000) / 1000;

	return { activations: out, intensity, intent, weight };
}
