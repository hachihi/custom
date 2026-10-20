// Truy cập D1: session, bộ đếm chống spam, nhật ký

export async function getSession(DB, idHash) {
  const r = await DB.prepare('SELECT data FROM sessions WHERE id = ?1 AND expires_at > ?2')
    .bind(idHash, Date.now()).first();
  return r ? JSON.parse(r.data) : null;
}

export async function putSession(DB, idHash, data, ttlSec) {
  await DB.prepare(
    `INSERT INTO sessions (id, data, expires_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`)
    .bind(idHash, JSON.stringify(data), Date.now() + ttlSec * 1000).run();
}

export async function delSession(DB, idHash) {
  await DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(idHash).run();
}

/**
 * Đếm lượt trong một câu lệnh duy nhất (nguyên tử).
 * Trả về true nếu vẫn trong hạn mức `max` trong `windowSec` giây.
 */
export async function hit(DB, key, max, windowSec) {
  const now = Date.now();
  const r = await DB.prepare(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?2 + ?3 * 1000)
     ON CONFLICT(key) DO UPDATE SET
       count    = CASE WHEN reset_at <= ?2 THEN 1 ELSE count + 1 END,
       reset_at = CASE WHEN reset_at <= ?2 THEN ?2 + ?3 * 1000 ELSE reset_at END
     RETURNING count`)
    .bind(key, now, windowSec).first();
  return r.count <= max;
}

export async function audit(DB, row) {
  await DB.prepare(
    `INSERT INTO audit_log (ts, event, ip, session_hint, identifier_hash, partner_ids, detail)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
    .bind(
      Date.now(), row.event, row.ip || null, row.session || null, row.idh || null,
      row.partners ? JSON.stringify(row.partners) : null,
      row.detail ? JSON.stringify(row.detail) : null,
    ).run();
}

/** Dọn dữ liệu hết hạn và log quá hạn lưu */
export async function purge(DB, retentionDays) {
  const now = Date.now();
  await DB.batch([
    DB.prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(now),
    DB.prepare('DELETE FROM rate_limits WHERE reset_at <= ?1').bind(now),
    DB.prepare('DELETE FROM audit_log WHERE ts <= ?1').bind(now - retentionDays * 86400000),
  ]);
}
