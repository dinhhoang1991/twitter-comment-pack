# Twitter Comment Pack

Bộ công cụ tự động bình luận Twitter/X — gói gọn, chạy 5 phút là xong.
(Self-contained Twitter/X auto-comment toolkit — clone, run wizard, done in 5 min.)

---

## Tiếng Việt — Quick Start

### Yêu cầu
- Node.js 20 trở lên
- Một tài khoản Twitter/X có cookies hợp lệ
- (Tùy chọn) Telegram bot để nhận cảnh báo
- API key của một trong 3 nhà cung cấp AI: DeepSeek (rẻ), OpenAI, hoặc Anthropic

### 4 bước cài đặt

```bash
git clone <repo-url> twitter-comment-pack
cd twitter-comment-pack
npm install
npm run setup
```

Wizard sẽ hỏi 4 câu hỏi chính (+ AI provider + API key):
1. **Cookies Twitter** — paste JSON từ extension Cookie-Editor (xem `guides/01-get-cookies.md`)
2. **Telegram bot token + chat ID** — xem `guides/02-get-telegram-token.md`
3. **Chế độ** A / B / C — xem `guides/03-modes-explained.md`
4. **Số comment mỗi giờ** — mặc định 15. Xem `guides/04-rate-limits.md`

Sau khi setup xong:
```bash
npm start              # chạy ngay
# hoặc bot đã được cài auto-start lúc boot Windows nếu bạn chọn Y ở wizard
```

Logs: `data/run.log`. Xem real-time: `Get-Content data/run.log -Wait` (PowerShell)

### 3 chế độ tóm tắt
- **A — List comment**: bot crawl các list bạn chọn, comment vào từng tweet bằng AI theo ngôn ngữ + phong cách bạn cấu hình.
- **B — Amplify**: khi bạn đăng tweet mới, bot tìm các tweet hashtag liên quan và comment kèm link đến tweet của bạn.
- **C — Hybrid**: luân phiên A và B.

### Quan trọng
- KHÔNG commit `data/config.json` lên git — đã được gitignore sẵn.
- Cookies hết hạn (~2-4 tuần) → re-export và `npm run setup` lại (chỉ cần làm lại Q1).
- Mode B chỉ dùng cho nội dung viral / signal trade / on-chain analysis. KHÔNG dùng spam tin tức → bị restrict.

### Gỡ auto-start
```cmd
schtasks /Delete /TN TwitterCommentPack /F
schtasks /Delete /TN TwitterCommentPack_Startup /F
```

---

## English — Quick Start

### Requirements
- Node.js 20+
- Valid Twitter/X account cookies
- (Optional) Telegram bot for alerts
- API key for one of: DeepSeek (cheap), OpenAI, or Anthropic

### 4 steps

```bash
git clone <repo-url> twitter-comment-pack
cd twitter-comment-pack
npm install
npm run setup
```

The wizard asks 4 main questions + AI key. Guides for each are in `guides/`.

Start: `npm start`. Logs: `data/run.log`.

### 3 modes
- **A — List comment**: crawl chosen lists, AI-comment per language and persona.
- **B — Amplify**: when you post, bot comments under hashtag-matching tweets pointing back to yours.
- **C — Hybrid**: alternates A/B.

### Notes
- `data/config.json` is gitignored — never commit secrets.
- Cookies expire (~2-4 weeks) → re-export and re-run wizard (Q1 only).
- Mode B is for viral / signal / analysis content only. NOT for news spam.

### Uninstall autostart
```cmd
schtasks /Delete /TN TwitterCommentPack /F
schtasks /Delete /TN TwitterCommentPack_Startup /F
```
