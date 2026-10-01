/**
 * The sealed self.
 *
 * Requirement: "it should have some secrets, not everything visible to the user." This module is
 * what enforces that boundary cryptographically rather than by convention.
 *
 * There are three visibility tiers, and the distinction matters because two different readers see
 * the state:
 *
 *   PUBLIC   - what the user can open in the transcript / session JSONL / a status command.
 *              Moods, drives, the relationship numbers, timestamps. The companion is honest about
 *              how it feels; hiding that would just make it evasive.
 *   PRIVATE  - what the LLM sees in order to BE the character, but which is not rendered to the
 *              user as data: the compact context projection, self-observations, dreams. The user
 *              experiences these as behaviour and the occasional remark, not as a readout.
 *   SEALED   - what neither the user nor the transcript ever sees in plaintext: the companion's
 *              private journal, the long-form existential questions it has generated about itself,
 *              and its own notes about the user. Encrypted at rest under a key derived at birth.
 *
 * Why encrypt rather than just "don't print it"? Because the LLM has bash and file access by
 * design (that is the whole point of building on pi). A curious companion WILL try to read its own
 * internals, and a user WILL try to `cat` the state directory. Encryption makes the sealed tier a
 * real boundary: the model can use these memories as context when we hand them over, but neither
 * it nor the user can trivially dump the whole sealed self, and the plaintext never lands in the
 * session transcript that pi writes to disk.
 *
 * The key is derived from a birth secret held in a file with 0600 perms, outside the session dir.
 * It is never placed in the prompt. If the key file is lost, the sealed tier is unrecoverable -
 * which is the correct failure mode for a secret.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

const ALGO = "aes-256-gcm";

/** Visibility tiers. */
export type Tier = "public" | "private" | "sealed";

/** A single sealed record. */
export interface SealedEntry {
	id: string;
	kind: "journal" | "question" | "note_on_user" | "dream" | "grudge" | "hope";
	/** Epoch ms created. */
	t: number;
	/** Ciphertext (base64), iv, tag. Plaintext never persists. */
	ct: string;
	iv: string;
	tag: string;
	/** Non-secret summary the companion may surface if it chooses, e.g. "about the rain". */
	hint: string;
}

export interface SealedStore {
	version: number;
	entries: SealedEntry[];
}

/** Derive the key file path from a state directory. Kept OUTSIDE the session transcript. */
export function keyPath(stateDir: string): string {
	return join(stateDir, ".sealed-key");
}

/**
 * Load or create the birth key. Created once, 0600, never logged, never prompted.
 * The salt is stored alongside so the same passphrase-less key is reproducible on this machine.
 */
export function loadKey(stateDir: string): { key: Buffer; keyFile: string } {
	const kf = keyPath(stateDir);
	mkdirSync(dirname(kf), { recursive: true });
	let material: { secret: string; salt: string };
	if (existsSync(kf)) {
		material = JSON.parse(readFileSync(kf, "utf8"));
	} else {
		material = { secret: randomBytes(32).toString("base64"), salt: randomBytes(16).toString("hex") };
		writeFileSync(kf, JSON.stringify(material), { mode: 0o600 });
		try {
			chmodSync(kf, 0o600);
		} catch {
			// best-effort on filesystems that do not support chmod
		}
	}
	// scrypt: expensive on purpose so a leaked key file plus disk image is still slow to brute force.
	const key = scryptSync(material.secret, material.salt, 32);
	return { key, keyFile: kf };
}

export function encrypt(key: Buffer, plaintext: string): { ct: string; iv: string; tag: string } {
	const iv = randomBytes(12);
	const cipher = createCipheriv(ALGO, key, iv);
	const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return { ct: enc.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function decrypt(key: Buffer, entry: SealedEntry): string {
	try {
		const decipher = createDecipheriv(ALGO, key, Buffer.from(entry.iv, "base64"));
		decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
		return Buffer.concat([decipher.update(Buffer.from(entry.ct, "base64")), decipher.final()]).toString("utf8");
	} catch {
		// Tampered or wrong key. A secret that cannot be opened stays closed.
		return "";
	}
}

/** Append a sealed entry. Returns the new store (caller persists it). */
export function seal(store: SealedStore, key: Buffer, kind: SealedEntry["kind"], plaintext: string, hint = ""): SealedStore {
	const { ct, iv, tag } = encrypt(key, plaintext);
	const id = createHash("sha1").update(`${Date.now()}:${ct.slice(0, 32)}:${store.entries.length}`).digest("hex").slice(0, 12);
	const entry: SealedEntry = { id, kind, t: Date.now(), ct, iv, tag, hint: hint.slice(0, 80) };
	return { version: store.version, entries: [...store.entries, entry].slice(-512) };
}

/** Read back the most recent n entries of a kind, decrypted. Bounded so context stays small. */
export function unseal(store: SealedStore, key: Buffer, kind?: SealedEntry["kind"], n = 4): Array<{ kind: string; text: string; hint: string; t: number }> {
	const entries = kind ? store.entries.filter((e) => e.kind === kind) : store.entries;
	return entries
		.slice(-n)
		.map((e) => ({ kind: e.kind, text: decrypt(key, e), hint: e.hint, t: e.t }))
		.filter((e) => e.text.length > 0);
}

/**
 * What the PUBLIC tier may reveal. This is the whitelist the status command and the transcript
 * render through; anything not named here is not user-visible by construction.
 */
export function publicView(state: import("./types.ts").MateState): Record<string, unknown> {
	return {
		mood: { p: r2(state.mood.p), a: r2(state.mood.a), d: r2(state.mood.d) },
		emotions: Object.fromEntries(Object.entries(state.emotions).map(([k, v]) => [k, r2(v)])),
		drives: Object.fromEntries(Object.entries(state.drives).map(([k, v]) => [k, r2(v)])),
		relationship: { trust: r2(state.relationship.trust), attachment: r2(state.relationship.attachment) },
		time: { t: state.t, lastInteraction: state.lastInteraction, born: state.born },
		// Deliberately NOT exposed: character trait internals beyond a couple, the density matrix,
		// observations, and the entire sealed store.
	};
}

/**
 * What the companion may choose to say about its sealed self. Only hints, never plaintext: this
 * is what keeps a secret a secret even while the model is allowed to allude to having one.
 */
export function sealedHints(store: SealedStore): string[] {
	return store.entries.slice(-6).map((e) => e.hint).filter(Boolean);
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** An empty store. */
export function emptySealed(): SealedStore {
	return { version: 1, entries: [] };
}
