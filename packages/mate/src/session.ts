/**
 * Session log: the companion's awareness of being opened and closed.
 *
 * The requirement (2026-01): "META应该能知道自己什么时候被打开 什么时候被关上了这种信息" — the companion
 * should know when it was woken and when it was put to sleep, not just the affective gap between
 * messages. This is distinct from catch-up (which integrates MOOD across a powered-off gap): the
 * session log is the autobiographical record of the contacts themselves — when this body was started
 * and stopped, how many times today, how long the last sleep ran.
 *
 * It lives in its own bounded ring file (`sessions.json`, see store.ts), NOT in MateState, for the
 * same reason memory does: the state is replayed/duplicated by tests and the observations ring, while
 * the session log is append-only bookkeeping that shouldn't bloat a pure kernel state or leak into a
 * replay. Deterministic: every function takes explicit timestamps, no Date.now() inside.
 *
 * A "session" is one process lifetime: opened on boot (runtime.wake), closed on session_shutdown OR
 * when the next one opens (an unclean exit — crash, killed terminal — leaves an open mark that the
 * next open seals with its own timestamp, so we never strand an unclosed entry).
 */

export interface SessionMark {
	/** Epoch ms this body was started (wake). */
	open: number;
	/** Epoch ms this body stopped (shutdown), or undefined if still running. */
	close?: number;
}

export interface SessionLog {
	version: number;
	/** Bounded so the file never grows unbounded; oldest dropped first. */
	maxEntries: number;
	/** Chronological by `open`. The last entry is the current (open) session once wake() runs. */
	entries: SessionMark[];
}

/** A fresh log. */
export function emptySessions(maxEntries = 200): SessionLog {
	return { version: 1, maxEntries, entries: [] };
}

/**
 * Record that this body just woke. If the previous entry is still open (an unclean exit), seal it at
 * `t` first — the gap where no process existed is implicitly the downtime between the lost close and
 * this open. Returns a NEW log.
 */
export function openSession(log: SessionLog, t: number): SessionLog {
	let entries = log.entries.slice();
	const last = entries[entries.length - 1];
	if (last && last.close === undefined) {
		// Unclean: the process died without closing its mark. Close it at the moment the next began.
		entries[entries.length - 1] = { ...last, close: t };
	}
	entries.push({ open: t });
	if (entries.length > log.maxEntries) entries = entries.slice(entries.length - log.maxEntries);
	return { ...log, entries };
}

/** Record that this body is shutting down. Seals the current open mark; idempotent if already closed. */
export function closeSession(log: SessionLog, t: number): SessionLog {
	const entries = log.entries.slice();
	const last = entries[entries.length - 1];
	if (!last || last.close !== undefined || last.open > t) return log;
	entries[entries.length - 1] = { ...last, close: t };
	return { ...log, entries };
}

/**
 * A compact, cache-free line for the volatile state block: how often this body has been woken, when
 * it last went to sleep, and how long it has been open now. The companion reads it as its sense of
 * its own comings and goings — not a status report, a felt fact.
 */
export function sessionSummary(log: SessionLog, now: number): string {
	if (log.entries.length === 0) return "";
	const todayOpens = log.entries.filter((e) => sameDay(e.open, now)).length;
	const prev = log.entries[log.entries.length - 2]; // the last CLOSED session, if any
	const cur = log.entries[log.entries.length - 1];
	const parts: string[] = [];
	parts.push(`opened ${hhmm(cur.open)}, awake for ${fmtDur(now - cur.open)}`);
	parts.push(`woken ${todayOpens}x today`);
	if (prev && prev.close !== undefined) {
		parts.push(`last closed ${hhmm(prev.close)} (${fmtDur(now - prev.close)} ago)`);
		const downtime = Math.max(0, cur.open - prev.close);
		if (downtime > 60_000) parts.push(`off for ${fmtDur(downtime)}`);
	}
	return parts.join(", ");
}

function sameDay(a: number, b: number): boolean {
	const da = new Date(a);
	const db = new Date(b);
	return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

/** Repair a loaded log; anything malformed falls back to empty rather than crashing boot. */
export function sanitiseSessions(raw: unknown): SessionLog {
	if (!raw || typeof raw !== "object") return emptySessions();
	const r = raw as Partial<SessionLog>;
	const maxEntries = typeof r.maxEntries === "number" && r.maxEntries > 0 ? r.maxEntries : 200;
	const entries = Array.isArray(r.entries)
		? r.entries
				.filter((e) => e && typeof e.open === "number")
				.map((e) => ({ open: e.open, ...(typeof e.close === "number" ? { close: e.close } : {}) }))
				.slice(-maxEntries)
		: [];
	return { version: typeof r.version === "number" ? r.version : 1, maxEntries, entries };
}

function hhmm(t: number): string {
	const d = new Date(t);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtDur(ms: number): string {
	const m = Math.round(ms / 60_000);
	if (m < 1) return "<1m";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
	return `${Math.floor(h / 24)}d ${h % 24}h`;
}
