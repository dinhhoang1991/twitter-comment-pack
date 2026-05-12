# Cách lấy cookies Twitter / How to export Twitter cookies

## Tiếng Việt

1. Cài extension **Cookie-Editor** vào Chrome / Brave / Edge:
   https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm
2. Mở `https://x.com` và đăng nhập tài khoản bạn muốn dùng để comment.
3. Click icon Cookie-Editor → góc dưới cùng phải có nút **Export → Export as JSON**. Click.
4. Cookies (dạng JSON array) đã được copy vào clipboard.
5. Khi wizard hỏi cookies, paste nguyên đoạn JSON đó. Type `EOF` rồi Enter để kết thúc.

### Format được chấp nhận

Wizard nhận 2 format:

**Format 1 — Cookie-Editor JSON array (recommended):**
```json
[
  {"name": "auth_token", "value": "abc123...", "domain": ".x.com", "path": "/"},
  {"name": "ct0", "value": "def456...", "domain": ".x.com", "path": "/"},
  ...
]
```

**Format 2 — Object ngắn gọn:**
```json
{"auth_token": "abc123...", "ct0": "def456..."}
```

Hai cookies bắt buộc: `auth_token` và `ct0`. Nếu thiếu, wizard sẽ báo lỗi.

### Cookies hết hạn?

Sau ~2-4 tuần, Twitter có thể invalidate session. Triệu chứng: log có `SESSION_EXPIRED` hoặc `401/403`. Cách fix: export lại cookies, chạy `npm run setup` và làm lại Q1 (các câu khác cứ Enter để giữ nguyên).

## English

1. Install the **Cookie-Editor** browser extension.
2. Open `https://x.com` and log in.
3. Click extension icon → bottom-right "Export → Export as JSON".
4. Paste into the wizard when prompted. End with `EOF` on a new line.

Required cookies: `auth_token` and `ct0`. The wizard accepts the full JSON array OR a `{auth_token, ct0}` object.

When cookies expire (~2-4 weeks → `SESSION_EXPIRED` in logs), re-export and re-run the wizard.
