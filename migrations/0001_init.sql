-- Session đăng nhập (khóa là SHA-256 của cookie, không lưu cookie gốc)
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  data       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_exp ON sessions(expires_at);

-- Bộ đếm chống spam / dò OTP
CREATE TABLE rate_limits (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE INDEX idx_rate_reset ON rate_limits(reset_at);

-- Nhật ký truy cập. Không lưu email/SĐT gốc, chỉ lưu bản băm.
CREATE TABLE audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,   -- mili giây UTC
  event           TEXT    NOT NULL,   -- lookup | otp_fail | login_otp | login_google | view_order ...
  ip              TEXT,
  session_hint    TEXT,               -- 8 ký tự đầu của hash session, để lần theo một phiên
  identifier_hash TEXT,               -- hash của email/SĐT khách nhập
  partner_ids     TEXT,               -- JSON: id res.partner trong Odoo
  detail          TEXT                -- JSON bổ sung
);
CREATE INDEX idx_audit_ts    ON audit_log(ts);
CREATE INDEX idx_audit_event ON audit_log(event, ts);
CREATE INDEX idx_audit_idh   ON audit_log(identifier_hash, ts);
