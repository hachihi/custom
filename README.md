# Cổng tra cứu đơn hàng / ticket — Odoo 14 + Cloudflare Workers + D1

Khách **đăng nhập Google**. Worker xác minh token, lấy email đã được Google xác minh rồi tìm khách có **đúng email đó** trong Odoo. Khớp thì cho xem đơn hàng, phiếu giao và ticket của chính khách. Đăng nhập được **ghi nhớ trong session** (mặc định 72 giờ), lần sau khách vào thẳng.

D1 lưu: session, bộ đếm chống spam và **nhật ký truy cập** (`audit_log`).

## Cấu trúc

```
public/            giao diện tĩnh (index.html, app.js, style.css, _headers)
src/index.js       Worker (Hono): API, đăng nhập Google, session, nhật ký, cron dọn dữ liệu
src/odoo.js        client Odoo 14 (JSON-RPC)
src/db.js          truy cập D1
migrations/        schema D1
wrangler.toml      cấu hình Worker, D1, cron, biến môi trường
```

## 1. Tạo Google OAuth Client ID

1. Vào [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → Create credentials → **OAuth client ID** → loại **Web application**.
2. Mục **Authorized JavaScript origins** thêm địa chỉ web của bạn, ví dụ `https://order-portal.<tai-khoan>.workers.dev` và tên miền riêng nếu có. Khi chạy local thêm `http://localhost:8787`.
3. Copy Client ID (dạng `xxxx.apps.googleusercontent.com`) vào `GOOGLE_CLIENT_ID` trong `wrangler.toml`. Đây không phải secret.
4. Nếu app đang ở trạng thái Testing, chỉ các tài khoản trong danh sách test user mới đăng nhập được. Chuyển sang In production để mọi khách dùng được.

Lưu ý: khách cần có tài khoản Google gắn với email dùng khi mua hàng. Email công ty không phải Gmail vẫn dùng được nếu khách đã tạo tài khoản Google bằng email đó.

## 2. Chuẩn bị Odoo 14

1. Tạo user riêng `portal-api`, chỉ cấp quyền **đọc**: Sales, Inventory (xem phiếu giao), Helpdesk (nếu dùng ticket), Contacts.
2. Tạo API key cho user đó (Preferences → Account Security → New API Key) rồi dùng làm `ODOO_API_KEY`. Nếu bản Odoo của bạn không có mục này, dùng mật khẩu riêng của user `portal-api`.
3. Odoo phải truy cập được từ Internet qua HTTPS (nên đặt sau nginx ở cổng 443). Worker gọi `https://<odoo>/jsonrpc`.
4. Email của khách trong Odoo (`res.partner.email`) phải trùng email Google của họ (không phân biệt hoa thường).

## 3. Triển khai

```bash
npm install
npx wrangler login

# Tạo D1, copy database_id vào wrangler.toml
npx wrangler d1 create portal-db
npm run db:migrate            # tạo bảng trên D1 thật

# Sửa [vars] trong wrangler.toml: GOOGLE_CLIENT_ID, ODOO_URL, ODOO_DB, ODOO_USER

# Secret (không commit lên GitHub)
npx wrangler secret put ODOO_API_KEY

npm run deploy
```

**Tự động deploy từ GitHub:** Cloudflare dashboard → Workers & Pages → Create → Import a repository → chọn repo. `ODOO_API_KEY` đặt trong Settings → Variables and Secrets của Worker. Migration chạy tay bằng `npm run db:migrate` mỗi khi thêm file trong `migrations/`.

**Chạy local:** copy `.dev.vars.example` thành `.dev.vars` (điền `ODOO_API_KEY`), điền `GOOGLE_CLIENT_ID` vào `wrangler.toml`, chạy `npm run db:migrate:local` rồi `npm run dev` và mở `http://localhost:8787`.

## Nhật ký (audit_log)

Mỗi dòng gồm thời gian, sự kiện, IP, mã rút gọn của session, **bản băm** của email (không lưu email gốc), id partner Odoo và chi tiết.

Sự kiện: `login_google`, `google_no_match` (Google đúng nhưng email không có trong Odoo), `google_unverified`, `google_invalid` (token sai/hết hạn/sai client), `logout`, `view_order`, `view_ticket` (hai sự kiện cuối tắt bằng `LOG_VIEWS = "0"`).

```bash
# 20 sự kiện gần nhất
npx wrangler d1 execute portal-db --remote --command \
 "SELECT datetime(ts/1000,'unixepoch','+7 hours') AS gio, event, ip, partner_ids, detail FROM audit_log ORDER BY id DESC LIMIT 20"

# IP có nhiều token không hợp lệ nhất trong 24 giờ
npx wrangler d1 execute portal-db --remote --command \
 "SELECT ip, COUNT(*) n FROM audit_log WHERE event='google_invalid' AND ts > (strftime('%s','now')-86400)*1000 GROUP BY ip ORDER BY n DESC LIMIT 10"

# Lịch sử xem của một khách (partner id 7)
npx wrangler d1 execute portal-db --remote --command \
 "SELECT datetime(ts/1000,'unixepoch','+7 hours') AS gio, event, detail FROM audit_log WHERE partner_ids LIKE '%7%' ORDER BY id DESC LIMIT 50"
```

Cron chạy mỗi ngày lúc 03:17 (giờ VN) xoá log quá `LOG_RETENTION_DAYS` (mặc định 90 ngày) và các session, bộ đếm đã hết hạn. IP là dữ liệu cá nhân, nên chọn thời gian lưu phù hợp với chính sách của công ty.

## Bảo mật đã có

- Token Google được kiểm tra chữ ký bằng khóa công khai của Google, đúng `iss`, đúng `aud` (client ID của bạn), còn hạn, và `email_verified = true`.
- Chỉ khách có email trùng trong Odoo mới vào được; sai thì trả thông báo chung, không lộ dữ liệu.
- Cookie session chỉ chứa ID ngẫu nhiên 256 bit (`HttpOnly`, `Secure`, `SameSite=Lax`); D1 chỉ lưu bản băm của ID. Đổi ID sau khi đăng nhập.
- Mọi truy vấn lọc theo `partner_id child_of <partner trong session>`, nên không xem được đơn của người khác dù đoán ID.
- Ticket chỉ lấy tin nhắn công khai. Giao diện chỉ dùng `textContent`. POST yêu cầu JSON và kiểm tra Origin. Giới hạn 30 lần đăng nhập/15 phút cho mỗi IP.

## Giới hạn gói miễn phí cần để ý

- Workers Free: 100.000 request/ngày, 10 ms CPU/request (thời gian chờ Odoo không tính vào CPU). Bước kiểm tra chữ ký token dùng CPU nhiều hơn các API khác, nên theo dõi lỗi vượt CPU trong dashboard sau khi chạy thật.
- D1 Free: 100.000 lượt ghi/ngày. Mỗi lần đăng nhập tốn vài lượt ghi; mỗi lần xem chi tiết thêm 1 lượt nếu bật `LOG_VIEWS`. Vượt hạn mức thì truy vấn lỗi đến 0h UTC rồi tự mở lại.
