import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createOdoo, normalizeEmail } from './odoo.js';
import { sha256Hex, randomId } from './crypto.js';
import * as db from './db.js';

const COOKIE = 'portal.sid';
const SID_RE = /^[A-Za-z0-9_-]{43}$/;
const TOO_MANY = 'Bạn thao tác quá nhiều lần, vui lòng thử lại sau.';

// GOOGLE_JWKS_URL chỉ dùng khi chạy test; mặc định là khóa công khai của Google
const jwksCache = new Map();
const googleJwks = url => {
  if (!jwksCache.has(url)) jwksCache.set(url, createRemoteJWKSet(new URL(url)));
  return jwksCache.get(url);
};

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const settings = env => ({
  authTtlMs: num(env.SESSION_TTL_HOURS, 72) * 3600e3,
  logViews: env.LOG_VIEWS !== '0',
});

const clientIp = c => c.req.header('CF-Connecting-IP') || '';
const isHttps = c => new URL(c.req.url).protocol === 'https:';
const readJson = c => c.req.json().catch(() => ({}));

function maskEmail(e) {
  const [u, d] = String(e).split('@');
  return `${u.slice(0, 2)}${'*'.repeat(Math.max(1, u.length - 2))}@${d}`;
}

/* ---------------- nhật ký (ghi nền, không làm chậm phản hồi) ---------------- */

function log(c, event, { idh, partners, detail } = {}) {
  const S = c.get('S');
  const sid = S.id; // đọc ngay, vì session có thể bị đổi sau đó
  const ip = clientIp(c);
  const job = (async () => {
    const session = sid ? (await sha256Hex(sid)).slice(0, 8) : null;
    await db.audit(c.env.DB, { event, ip, session, idh, partners, detail });
  })().catch(e => console.error('audit lỗi:', e.message));
  c.executionCtx.waitUntil(job);
}

/* ---------------- session lưu trong D1 ---------------- */

async function saveSession(c) {
  const S = c.get('S');
  const k = settings(c.env);
  if (!S.id) S.id = randomId();
  const a = S.data.auth;
  const ttlSec = a ? Math.max(1, Math.floor((a.verifiedAt + k.authTtlMs - Date.now()) / 1000)) : 3600;
  await db.putSession(c.env.DB, await sha256Hex(S.id), S.data, ttlSec);
  setCookie(c, COOKIE, S.id, { httpOnly: true, sameSite: 'Lax', secure: isHttps(c), maxAge: ttlSec, path: '/' });
}

async function rotateSession(c) { // cấp ID mới, chống session fixation
  const S = c.get('S');
  if (S.id) await db.delSession(c.env.DB, await sha256Hex(S.id));
  S.id = null;
  S.data = {};
}

async function destroySession(c) {
  await rotateSession(c);
  deleteCookie(c, COOKIE, { path: '/' });
}

/* ---------------- app ---------------- */

const app = new Hono();
app.use('*', secureHeaders());

app.use('/api/*', async (c, next) => {
  // Chống CSRF: POST phải là JSON và (nếu có) Origin phải trùng host
  if (c.req.method === 'POST') {
    if (!(c.req.header('Content-Type') || '').includes('application/json')) return c.json({ error: 'Content-Type không hợp lệ' }, 415);
    const origin = c.req.header('Origin');
    if (origin && new URL(origin).host !== new URL(c.req.url).host) return c.json({ error: 'Origin không hợp lệ' }, 403);
  }
  // Nạp session
  const sid = getCookie(c, COOKIE);
  let id = null;
  let data = {};
  if (sid && SID_RE.test(sid)) {
    const row = await db.getSession(c.env.DB, await sha256Hex(sid));
    if (row) { id = sid; data = row; }
  }
  c.set('S', { id, data });
  await next();
});

const requireAuth = async (c, next) => {
  const a = c.get('S').data.auth;
  if (!a || Date.now() - a.verifiedAt > settings(c.env).authTtlMs) {
    return c.json({ error: 'Phiên đã hết hạn, vui lòng đăng nhập lại.' }, 401);
  }
  c.set('ids', a.ids);
  await next();
};

app.get('/api/config', c => {
  const odoo = createOdoo(c.env);
  return c.json({ googleClientId: c.env.GOOGLE_CLIENT_ID || null, tickets: odoo.ticketsEnabled() });
});

// Còn phiên → khách vào thẳng, không phải đăng nhập lại
app.get('/api/session', c => {
  const a = c.get('S').data.auth;
  if (!a || Date.now() - a.verifiedAt > settings(c.env).authTtlMs) return c.json({ authenticated: false });
  return c.json({ authenticated: true, name: a.name, email: maskEmail(a.email), expiresAt: a.verifiedAt + settings(c.env).authTtlMs });
});

// Đăng nhập Google: chỉ chấp nhận khi email đã xác minh và trùng email của khách trong Odoo
app.post('/api/auth/google', async c => {
  if (!c.env.GOOGLE_CLIENT_ID) return c.json({ error: 'Chưa cấu hình GOOGLE_CLIENT_ID.' }, 503);
  if (!(await db.hit(c.env.DB, 'ip:google:' + clientIp(c), 30, 900))) return c.json({ error: TOO_MANY }, 429);

  let payload;
  try {
    ({ payload } = await jwtVerify(
      String((await readJson(c)).credential || ''),
      googleJwks(c.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs'),
      { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: c.env.GOOGLE_CLIENT_ID },
    ));
  } catch (err) {
    log(c, 'google_invalid', { detail: { reason: String(err.code || err.message).slice(0, 80) } });
    return c.json({ error: 'Đăng nhập Google không hợp lệ.' }, 401);
  }
  if (!payload.email || payload.email_verified !== true) {
    log(c, 'google_unverified');
    return c.json({ error: 'Email Google chưa được xác minh.' }, 401);
  }

  const email = normalizeEmail(payload.email);
  const idh = (await sha256Hex(email)).slice(0, 32);
  const odoo = createOdoo(c.env);
  const { partners } = await odoo.findPartners(email);
  if (!partners.length) {
    log(c, 'google_no_match', { idh });
    return c.json({ error: 'Email này chưa có đơn hàng hoặc ticket trong hệ thống.' }, 404);
  }

  const ids = odoo.scopeIds(partners);
  const name = (partners.find(p => p.name) || {}).name || payload.name || '';
  await rotateSession(c);
  const S = c.get('S');
  S.data.auth = { ids, email, name, method: 'google', verifiedAt: Date.now() };
  await saveSession(c);
  log(c, 'login_google', { idh, partners: ids });
  return c.json({ ok: true, name, email: maskEmail(email), expiresAt: S.data.auth.verifiedAt + settings(c.env).authTtlMs });
});

app.post('/api/logout', async c => {
  log(c, 'logout', { partners: c.get('S').data.auth?.ids });
  await destroySession(c);
  return c.json({ ok: true });
});

/* ---------------- dữ liệu (cần đã đăng nhập) ---------------- */

const idParam = c => { const n = parseInt(c.req.param('id'), 10); return Number.isInteger(n) && n > 0 ? n : null; };

app.get('/api/orders', requireAuth, async c =>
  c.json(await createOdoo(c.env).listOrders(c.get('ids'))));

app.get('/api/orders/:id', requireAuth, async c => {
  const id = idParam(c);
  const order = id && await createOdoo(c.env).getOrder(c.get('ids'), id);
  if (!order) return c.json({ error: 'Không tìm thấy đơn hàng.' }, 404);
  if (settings(c.env).logViews) log(c, 'view_order', { partners: c.get('ids'), detail: { order: id } });
  return c.json(order);
});

app.get('/api/tickets', requireAuth, async c =>
  c.json(await createOdoo(c.env).listTickets(c.get('ids'))));

app.get('/api/tickets/:id', requireAuth, async c => {
  const id = idParam(c);
  const ticket = id && await createOdoo(c.env).getTicket(c.get('ids'), id);
  if (!ticket) return c.json({ error: 'Không tìm thấy ticket.' }, 404);
  if (settings(c.env).logViews) log(c, 'view_ticket', { partners: c.get('ids'), detail: { ticket: id } });
  return c.json(ticket);
});

app.all('/api/*', c => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Có lỗi xảy ra, vui lòng thử lại sau.' }, 500);
});

export default {
  fetch: app.fetch,
  // Cron hằng ngày: dọn session/bộ đếm hết hạn và log quá hạn lưu
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(db.purge(env.DB, num(env.LOG_RETENTION_DAYS, 90)));
  },
};
