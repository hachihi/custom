'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const views = { search: $('#view-search'), found: $('#view-found'), app: $('#view-app') };
  let config = { googleClientId: null, tickets: true };
  let currentTab = 'orders';

  /* ---------- tiện ích ---------- */
  const SALE_STATE = { sent: 'Đã gửi báo giá', sale: 'Đã xác nhận', done: 'Hoàn tất', cancel: 'Đã hủy' };
  const PICK_STATE = { draft: 'Nháp', waiting: 'Chờ xử lý', confirmed: 'Chờ hàng', assigned: 'Sẵn sàng giao', done: 'Đã giao', cancel: 'Đã hủy' };
  const INVOICE = { 'upselling': 'Có thể bán thêm', 'invoiced': 'Đã xuất hóa đơn', 'to invoice': 'Chờ xuất hóa đơn', 'no': 'Chưa có hóa đơn' };

  // Odoo trả thời gian UTC dạng "YYYY-MM-DD HH:MM:SS"
  function fmtDate(v) {
    if (!v) return '—';
    const d = new Date(String(v).replace(' ', 'T') + 'Z');
    return isNaN(d) ? v : d.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
  }
  function fmtMoney(n, cur) {
    const code = Array.isArray(cur) ? cur[1] : 'VND';
    try { return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: code }).format(n); }
    catch { return `${Number(n).toLocaleString('vi-VN')} ${code}`; }
  }

  // Tạo DOM an toàn (textContent), không bao giờ gán innerHTML từ dữ liệu Odoo
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* không có body */ }
    if (res.status === 401 && !path.startsWith('/api/auth')) { showSearch('Phiên đã hết hạn, vui lòng tìm kiếm và đăng nhập lại.'); }
    if (!res.ok) throw new Error(data.error || 'Có lỗi xảy ra, vui lòng thử lại.');
    return data;
  }

  function show(name) {
    for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
    $('#userbox').hidden = name !== 'app';
  }
  function setMsg(id, text, kind) { const el = $(id); el.textContent = text || ''; el.className = 'msg ' + (kind || ''); }

  /* ---------- bước 1: tìm kiếm (chưa cần đăng nhập) ---------- */
  function showSearch(msg) {
    show('search'); setMsg('#msg-search', msg || '', msg ? 'err' : '');
    $('#identifier').focus();
  }

  $('#form-search').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button.primary');
    btn.disabled = true; setMsg('#msg-search', '');
    try {
      const r = await api('/api/search', { identifier: $('#identifier').value });
      if (r.found) showFound(r.hints || []);
      else setMsg('#msg-search', 'Không tìm thấy đơn hàng hoặc ticket với thông tin này. Vui lòng kiểm tra lại số điện thoại hoặc email.', 'err');
    } catch (err) { setMsg('#msg-search', err.message, 'err'); }
    finally { btn.disabled = false; }
  });

  /* ---------- bước 2: đã tìm thấy → đăng nhập Google ---------- */
  function showFound(hints) {
    show('found'); setMsg('#msg-login', '');
    $('#found-hints').replaceChildren(...hints.map(x => h('li', {}, x)));
    $('#found-hints-wrap').hidden = hints.length === 0;
    $('#found-nomail').hidden = hints.length > 0;
    $('#google-btn').hidden = hints.length === 0;
    renderGoogle();
  }

  $('#btn-back').addEventListener('click', () => showSearch());

  $('#btn-logout').addEventListener('click', async () => {
    try { await api('/api/logout', {}); } catch { /* bỏ qua */ }
    $('#identifier').value = '';
    showSearch();
    if (window.google) google.accounts.id.disableAutoSelect();
  });

  let googleReady = false;
  function renderGoogle() {
    const el = $('#google-btn'); el.replaceChildren();
    if (!config.googleClientId) {
      setMsg('#msg-login', 'Hệ thống chưa cấu hình đăng nhập Google. Vui lòng liên hệ quản trị viên.', 'err');
      return;
    }
    if (!googleReady) return; // sẽ vẽ lại khi script Google tải xong
    google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', text: 'signin_with', locale: 'vi' });
  }

  function initGoogle() {
    if (!config.googleClientId) return;
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onerror = () => setMsg('#msg-login', 'Không tải được đăng nhập Google, vui lòng thử lại.', 'err');
    s.onload = () => {
      google.accounts.id.initialize({
        client_id: config.googleClientId,
        callback: async r => {
          try { enterApp(await api('/api/auth/google', { credential: r.credential })); }
          catch (err) { setMsg('#msg-login', err.message, 'err'); }
        },
      });
      googleReady = true;
      if (!views.found.hidden) renderGoogle();
    };
    document.head.append(s);
  }

  /* ---------- dashboard ---------- */
  function enterApp(info) {
    $('#whoami').textContent = [info.name, info.email].filter(Boolean).join(' · ');
    $('#tab-tickets').hidden = !config.tickets;
    show('app'); switchTab('orders');
  }

  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $('#detail').hidden = true; $('#list').hidden = false;
    tab === 'orders' ? loadOrders() : loadTickets();
  }

  async function loadOrders() {
    const box = $('#list'); box.replaceChildren(h('p', { class: 'empty' }, 'Đang tải…'));
    try {
      const rows = await api('/api/orders');
      if (!rows.length) return box.replaceChildren(h('p', { class: 'empty' }, 'Chưa có đơn hàng nào.'));
      box.replaceChildren(h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Mã đơn'), h('th', { class: 'hide-m' }, 'Ngày đặt'), h('th', {}, 'Trạng thái'), h('th', { class: 'num' }, 'Tổng tiền'))),
        h('tbody', {}, rows.map(o => h('tr', { class: 'row', tabindex: 0, onclick: () => openOrder(o.id), onkeydown: ev => ev.key === 'Enter' && openOrder(o.id) },
          h('td', {}, o.name), h('td', { class: 'hide-m' }, fmtDate(o.date_order)),
          h('td', {}, h('span', { class: 'badge' }, SALE_STATE[o.state] || o.state)),
          h('td', { class: 'num' }, fmtMoney(o.amount_total, o.currency_id)))))));
    } catch (err) { box.replaceChildren(h('p', { class: 'empty' }, err.message)); }
  }

  async function openOrder(id) {
    try {
      const o = await api('/api/orders/' + id);
      $('#list').hidden = true;
      const d = $('#detail'); d.hidden = false;
      d.replaceChildren(
        h('button', { class: 'link', onclick: () => switchTab('orders') }, '← Quay lại danh sách'),
        h('h2', {}, 'Đơn hàng ' + o.name),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Ngày đặt'), h('dd', {}, fmtDate(o.date_order)),
          h('dt', {}, 'Trạng thái'), h('dd', {}, SALE_STATE[o.state] || o.state),
          o.commitment_date && [h('dt', {}, 'Dự kiến giao'), h('dd', {}, fmtDate(o.commitment_date))],
          o.client_order_ref && [h('dt', {}, 'Mã tham chiếu'), h('dd', {}, o.client_order_ref)],
          h('dt', {}, 'Hóa đơn'), h('dd', {}, INVOICE[o.invoice_status] || o.invoice_status)),
        h('h3', {}, 'Sản phẩm'),
        h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Sản phẩm'), h('th', { class: 'num' }, 'SL'), h('th', { class: 'num hide-m' }, 'Đã giao'), h('th', { class: 'num' }, 'Thành tiền'))),
          h('tbody', {}, o.lines.map(l => h('tr', {},
            h('td', {}, l.name), h('td', { class: 'num' }, l.product_uom_qty),
            h('td', { class: 'num hide-m' }, l.qty_delivered), h('td', { class: 'num' }, fmtMoney(l.price_subtotal, o.currency_id)))))),
        h('div', { class: 'totals' },
          h('div', {}, h('span', {}, 'Chưa thuế'), h('span', {}, fmtMoney(o.amount_untaxed, o.currency_id))),
          h('div', {}, h('span', {}, 'Thuế'), h('span', {}, fmtMoney(o.amount_tax, o.currency_id))),
          h('div', { class: 'grand' }, h('span', {}, 'Tổng cộng'), h('span', {}, fmtMoney(o.amount_total, o.currency_id)))),
        o.pickings.length > 0 && [h('h3', {}, 'Giao hàng'),
          h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Phiếu'), h('th', {}, 'Trạng thái'), h('th', {}, 'Ngày'))),
            h('tbody', {}, o.pickings.map(p => h('tr', {},
              h('td', {}, p.name), h('td', {}, PICK_STATE[p.state] || p.state), h('td', {}, fmtDate(p.date_done || p.scheduled_date))))))]);
      window.scrollTo({ top: 0 });
    } catch (err) { alert(err.message); }
  }

  async function loadTickets() {
    const box = $('#list'); box.replaceChildren(h('p', { class: 'empty' }, 'Đang tải…'));
    try {
      const rows = await api('/api/tickets');
      if (!rows.length) return box.replaceChildren(h('p', { class: 'empty' }, 'Chưa có ticket nào.'));
      box.replaceChildren(h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Tiêu đề'), h('th', {}, 'Trạng thái'), h('th', { class: 'hide-m' }, 'Cập nhật'))),
        h('tbody', {}, rows.map(t => h('tr', { class: 'row', tabindex: 0, onclick: () => openTicket(t.id), onkeydown: ev => ev.key === 'Enter' && openTicket(t.id) },
          h('td', {}, t.name), h('td', {}, h('span', { class: 'badge' }, t.stage_id ? t.stage_id[1] : '—')),
          h('td', { class: 'hide-m' }, fmtDate(t.write_date)))))));
    } catch (err) { box.replaceChildren(h('p', { class: 'empty' }, err.message)); }
  }

  async function openTicket(id) {
    try {
      const t = await api('/api/tickets/' + id);
      $('#list').hidden = true;
      const d = $('#detail'); d.hidden = false;
      d.replaceChildren(
        h('button', { class: 'link', onclick: () => switchTab('tickets') }, '← Quay lại danh sách'),
        h('h2', {}, t.name),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Trạng thái'), h('dd', {}, t.stage_id ? t.stage_id[1] : '—'),
          h('dt', {}, 'Tạo lúc'), h('dd', {}, fmtDate(t.create_date)),
          h('dt', {}, 'Cập nhật'), h('dd', {}, fmtDate(t.write_date))),
        t.description && [h('h3', {}, 'Nội dung yêu cầu'), h('div', { class: 'msgbox' }, t.description)],
        h('h3', {}, 'Trao đổi'),
        t.messages.length
          ? t.messages.map(m => h('div', { class: 'msgbox' }, h('div', { class: 'meta' }, `${m.author || 'Hệ thống'} · ${fmtDate(m.date)}`), m.body))
          : h('p', { class: 'muted' }, 'Chưa có trao đổi nào.'));
      window.scrollTo({ top: 0 });
    } catch (err) { alert(err.message); }
  }

  /* ---------- khởi động: kiểm tra phiên đã lưu ---------- */
  (async () => {
    try { config = await api('/api/config'); } catch { /* dùng mặc định */ }
    initGoogle();
    try {
      const sess = await api('/api/session');
      if (sess.authenticated) return enterApp(sess);          // còn phiên → vào thẳng
      if (sess.pending) return showFound(sess.pending.hints);  // đã tìm thấy, đang chờ đăng nhập
    } catch { /* chưa có phiên */ }
    showSearch();
  })();
})();
