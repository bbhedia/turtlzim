// How often something may be done: a count per key in a window of time, in the database (no other service is needed, and it survives a restart).

/**
 * Count one try for `key`. Says whether it is allowed (at most `max` in the window of `seconds`), and, if not, in how many seconds it will be.
 * @returns {{ ok: boolean, retryAfter: number }}
 */
export function hit(db, key, max, seconds, now) {
  const row = db.prepare("select window_start, count from limits where key = ?").get(key);
  if (!row || now - row.window_start >= seconds) {
    db.prepare("insert into limits (key, window_start, count) values (?, ?, 1) on conflict(key) do update set window_start = excluded.window_start, count = 1").run(key, now);
    return { ok: true, retryAfter: 0 };
  }
  if (row.count >= max) return { ok: false, retryAfter: Math.max(1, row.window_start + seconds - now) };
  db.prepare("update limits set count = count + 1 where key = ?").run(key);
  return { ok: true, retryAfter: 0 };
}

/** Forget the counts whose window is over. */
export function sweep(db, now, longest = 24 * 3600) {
  return db.prepare("delete from limits where window_start < ?").run(now - longest).changes;
}
