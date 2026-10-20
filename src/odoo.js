// Client Odoo 14 qua JSON-RPC (/jsonrpc). Dùng user API riêng, chỉ có quyền đọc.

const uidCache = new Map(); // lưu trong isolate đang chạy, mất thì đăng nhập lại

/* ---------------- chuẩn hoá ---------------- */

export const normalizeEmail = v => String(v || '').trim().toLowerCase();

/** 9 chữ số cuối của số điện thoại (bỏ +84 / 0 đầu / ký tự phân cách) */
export function phoneKey(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : '';
}

/** Dạng chuẩn của thứ khách nhập, dùng để băm và giới hạn tần suất */
export function normalizeIdentifier(id) {
  const s = String(id || '').trim();
  return s.includes('@') ? normalizeEmail(s) : (phoneKey(s) || s.toLowerCase());
}

export function stripHtml(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------------- client ---------------- */

export function createOdoo(env) {
  const URL_ = String(env.ODOO_URL || '').replace(/\/$/, '');
  const DB = env.ODOO_DB;
  const USER = env.ODOO_USER;
  const KEY = env.ODOO_API_KEY;
  const PHONE_FIELDS = String(env.PARTNER_PHONE_FIELDS || 'phone,mobile').split(',').map(s => s.trim()).filter(Boolean);
  const ORDER_SCOPE = env.ORDER_SCOPE || 'self';
  const TICKET_MODEL = env.TICKET_MODEL === undefined ? 'helpdesk.ticket' : env.TICKET_MODEL;
  const cacheKey = `${URL_}|${DB}|${USER}`;

  async function rpc(service, method, args) {
    const res = await fetch(`${URL_}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: 1 }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Odoo HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.data?.message || data.error.message || 'Odoo error');
    return data.result;
  }

  async function getUid() {
    if (uidCache.has(cacheKey)) return uidCache.get(cacheKey);
    const uid = await rpc('common', 'login', [DB, USER, KEY]);
    if (!uid) throw new Error('Đăng nhập Odoo thất bại (kiểm tra ODOO_DB / ODOO_USER / ODOO_API_KEY)');
    uidCache.set(cacheKey, uid);
    return uid;
  }

  async function call(model, method, args = [], kwargs = {}) {
    const uid = await getUid();
    return rpc('object', 'execute_kw', [DB, uid, KEY, model, method, args, kwargs]);
  }

  const searchRead = (model, domain, fields, extra = {}) =>
    call(model, 'search_read', [domain], { fields, ...extra });

  /* ---------- tìm khách ---------- */

  const PARTNER_FIELDS = ['id', 'name', 'email', 'commercial_partner_id', ...PHONE_FIELDS];

  /** Tìm res.partner theo email hoặc SĐT. Trả về { partners, email }. */
  async function findPartners(identifier) {
    const id = String(identifier || '').trim();
    let partners = [];
    let otpEmail = null;

    if (id.includes('@')) {
      const email = normalizeEmail(id);
      const found = await searchRead('res.partner', [['email', '=ilike', email]], PARTNER_FIELDS, { limit: 20 });
      partners = found.filter(p => normalizeEmail(p.email) === email);
      if (partners.length) otpEmail = email;
    } else {
      const key = phoneKey(id);
      if (!key) return { partners: [], email: null };
      // '9%0%1%2...' khớp mọi kiểu định dạng: "090 123 4567", "+84-90-123-4567"...
      const pattern = key.split('').join('%');
      const domain = [];
      PHONE_FIELDS.forEach((f, i) => {
        if (i < PHONE_FIELDS.length - 1) domain.push('|');
        domain.push([f, 'ilike', pattern]);
      });
      const found = await searchRead('res.partner', domain, PARTNER_FIELDS, { limit: 50 });
      partners = found.filter(p => PHONE_FIELDS.some(f => phoneKey(p[f]) === key));
      const withMail = partners.find(p => p.email);
      if (withMail) otpEmail = normalizeEmail(withMail.email);
    }
    return { partners, email: otpEmail };
  }

  function scopeIds(partners) {
    const ids = new Set();
    for (const p of partners) {
      if (ORDER_SCOPE === 'commercial' && p.commercial_partner_id) ids.add(p.commercial_partner_id[0]);
      else ids.add(p.id);
    }
    return [...ids];
  }

  /* ---------- đơn hàng ---------- */

  const listOrders = ids => searchRead('sale.order',
    [['partner_id', 'child_of', ids], ['state', '!=', 'draft']],
    ['name', 'date_order', 'state', 'amount_total', 'currency_id', 'invoice_status'],
    { order: 'date_order desc', limit: 100 });

  async function getOrder(ids, orderId) {
    const domain = [['id', '=', orderId], ['partner_id', 'child_of', ids], ['state', '!=', 'draft']];
    const base = ['name', 'date_order', 'state', 'amount_untaxed', 'amount_tax', 'amount_total', 'currency_id', 'invoice_status'];
    let rows;
    try {
      rows = await searchRead('sale.order', domain, [...base, 'client_order_ref', 'commitment_date'], { limit: 1 });
    } catch (_) {
      rows = await searchRead('sale.order', domain, base, { limit: 1 });
    }
    const order = rows[0];
    if (!order) return null;

    const lines = await searchRead('sale.order.line',
      [['order_id', '=', orderId], ['display_type', '=', false]],
      ['name', 'product_uom_qty', 'qty_delivered', 'price_unit', 'price_subtotal'],
      { order: 'sequence, id' });

    let pickings = [];
    try {
      pickings = await searchRead('stock.picking', [['sale_id', '=', orderId]],
        ['name', 'state', 'scheduled_date', 'date_done'], { order: 'id' });
    } catch (_) { /* chưa cài module Kho */ }

    return { ...order, lines, pickings };
  }

  /* ---------- ticket ---------- */

  const ticketsEnabled = () => !!TICKET_MODEL;

  async function listTickets(ids) {
    if (!ticketsEnabled()) return [];
    return searchRead(TICKET_MODEL, [['partner_id', 'child_of', ids]],
      ['name', 'stage_id', 'create_date', 'write_date'], { order: 'write_date desc', limit: 100 });
  }

  async function getTicket(ids, ticketId) {
    if (!ticketsEnabled()) return null;
    const [t] = await searchRead(TICKET_MODEL,
      [['id', '=', ticketId], ['partner_id', 'child_of', ids]],
      ['name', 'stage_id', 'create_date', 'write_date', 'description'], { limit: 1 });
    if (!t) return null;

    // chỉ lấy tin nhắn công khai, không lấy ghi chú nội bộ
    const msgs = await searchRead('mail.message',
      [['model', '=', TICKET_MODEL], ['res_id', '=', ticketId],
        ['message_type', 'in', ['comment', 'email']], ['subtype_id.internal', '=', false]],
      ['date', 'author_id', 'body'], { order: 'date asc', limit: 100 });

    return {
      ...t,
      description: stripHtml(t.description),
      messages: msgs
        .map(m => ({ date: m.date, author: m.author_id ? m.author_id[1] : '', body: stripHtml(m.body) }))
        .filter(m => m.body),
    };
  }

  return { findPartners, scopeIds, ticketsEnabled, listOrders, getOrder, listTickets, getTicket };
}
