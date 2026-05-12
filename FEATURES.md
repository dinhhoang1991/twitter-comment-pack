# Twitter Comment Pack — Mô tả tính năng chi tiết

Bot Twitter/X tự động bình luận, tối ưu cho trader, creator, và analyst muốn tăng engagement mà không cần ngồi reply tay.

---

## 1. Cài đặt 5 phút bằng wizard

Toàn bộ cấu hình gói gọn trong **5 câu hỏi** chạy bằng `npm run setup`. Không cần sửa code, không cần đọc tài liệu kỹ thuật. Wizard sẽ:

- **Validate cookies ngay tại chỗ**: nếu thiếu `auth_token` hoặc `ct0` → báo lỗi rõ ràng, hướng dẫn export lại.
- **Test Telegram bot** (nếu cấu hình): gửi tin nhắn thử, xác nhận đúng `chat_id`.
- **Test AI provider**: gọi 1 request thật để kiểm tra API key + chọn model phù hợp.
- **Cho phép skip Telegram** nếu chưa muốn alert.
- **Lưu file `data/config.json` + `data/cookies.json`** đã chuẩn hóa, gitignored sẵn.

Nếu sau này muốn đổi cấu hình (vd thêm list mới, đổi rate, đổi style), chỉ cần chạy lại `npm run setup` — wizard giữ giá trị cũ làm default, chỉ override những gì bạn nhập mới.

---

## 2. Ba chế độ hoạt động

### Mode A — List Comment (an toàn nhất)

Bot crawl các Twitter list bạn chỉ định, comment vào tweet mới chưa từng comment.

- **Đa list**: nhập nhiều list ID phân cách bằng dấu phẩy, bot chia đều quota giữa các list theo round-robin.
- **Auto-detect ngôn ngữ tweet**: phân biệt tiếng Anh / Nhật / Hàn / Trung qua Unicode range, comment đúng ngôn ngữ tweet gốc → tự nhiên, không bị flag spam.
- **Có thể fix ngôn ngữ**: nếu chỉ muốn comment bằng 1 ngôn ngữ duy nhất (vd toàn EN), set `language: "en"`.
- **Style/persona tự do**: nhập prompt mô tả bot nên nói thế nào, ví dụ:
  - `"trader chuyên nghiệp, ngắn gọn dưới 200 ký tự, không emoji"`
  - `"casual, friendly, hay dùng meme"`
  - `"dùng tiếng Hàn formal, kết bằng câu hỏi"`
- **Mỗi list 1 style** (nâng cao): có thể đặt style khác nhau cho từng list bằng cách edit `data/config.json` sau wizard.
- **Dedup persistent**: SQLite lưu mọi tweet đã comment → restart bot không bao giờ comment trùng.

### Mode B — Amplify Own Posts (tăng view 30k–80k/post)

Khi bạn đăng tweet mới, bot tự động đi comment vào các tweet đang hot trong các hashtag liên quan, kèm link về tweet của bạn → kéo audience về.

- **Auto-detect tweet mới của bạn**: poll timeline `@ownerUsername` mỗi 60 giây.
- **Multi-hashtag scan**: mặc định `#XAUUSD #Gold #Crypto #Bitcoin`, có thể thay thế hoàn toàn bằng hashtag của bạn.
- **Comment thông minh**: AI sinh comment liên quan đến tweet target + chèn link tự nhiên (không hard-sell).
- **Window 4h**: chỉ comment vào tweet ≤4h tuổi → tweet đang được Twitter đẩy.
- **Re-sweep mỗi 3 phút** cho đến khi bạn post tweet tiếp theo.
- **Chuyển campaign tự động**: khi phát hiện tweet mới của bạn → ngừng amplify tweet cũ, chuyển sang tweet mới ngay.

⚠️ **Cảnh báo bắt buộc đọc**: Mode B CHỈ phù hợp cho:
- Video viral
- Tutorial / hướng dẫn
- Signal trade (gold, crypto, forex)
- On-chain analysis
- Technical analysis

KHÔNG dùng cho spam tin tức, news repost, hay nội dung không có giá trị thực sự cho người đọc hashtag → Twitter sẽ restrict/shadowban nick bạn.

### Mode C — Hybrid

Luân phiên A và B mỗi cycle. Tổng comment vẫn bị giới hạn bởi `commentsPerHour` — khuyến nghị tăng rate (20–25/hr) để cả 2 mode có chỗ chạy.

---

## 3. Đa nhà cung cấp AI — bạn cầm chìa khóa

Bot không bundle AI sẵn. Bạn cung cấp API key của 1 trong 3 provider, tùy ngân sách và chất lượng:

| Provider | Model mặc định | Giá tham khảo (per 1M token) | Chất lượng |
|---|---|---|---|
| **DeepSeek** | `deepseek-chat` | ~$0.14 input / $0.28 output | Tốt cho chi phí, hỗ trợ tốt CJK |
| **OpenAI** | `gpt-4o-mini` | ~$0.15 input / $0.60 output | Cân bằng |
| **Anthropic** | `claude-haiku-4-5` | ~$1 input / $5 output | Tự nhiên nhất, đắt hơn |

- **Override model bất kỳ lúc nào**: edit `data/config.json` field `ai.model`.
- **Switch provider** chỉ cần chạy lại wizard.
- **Không vendor lock-in**: prompt được build chuẩn hóa, mọi provider đều dùng cùng template.
- **Gọi qua HTTP `fetch` trực tiếp**: không phụ thuộc SDK của provider → không bị break khi SDK update breaking change.

---

## 4. Rate limit thông minh

`commentsPerHour` không phải con số cứng. Bot:

- **Jitter delay 30–90 giây** giữa các comment → trông như người thật, không phải burst.
- **Backoff khi gặp 429/403**: pause 15–30 phút, gửi alert Telegram, tự động resume.
- **Soft fail vs hard fail**:
  - Soft fail (1 tweet bị block, network blip) → bỏ qua, tiếp tục.
  - 5 soft fail liên tiếp → pause 2–4h, tránh bị Twitter flag.
  - Hard fail (cookies expired, account verify) → STOP, alert Telegram khẩn.
- **Khuyến nghị**:
  - 10–15/hr: an toàn, có thể chạy 24/7 lâu dài
  - 20–25/hr: aggressive, nên có account đã warm
  - >30/hr: rủi ro cao, không khuyến khích

---

## 5. Telegram alert (optional nhưng khuyến nghị)

Khi cấu hình `telegram.botToken` + `telegram.chatId`, bot gửi:

- **Status report mỗi 4h**: số comment đã post, số tweet skip, lỗi nếu có.
- **Alert tức thì** khi:
  - Cookies hết hạn (SESSION_EXPIRED)
  - Account bị restrict posting (NO_POST_BUTTON)
  - AI provider trả 401 (sai API key) hoặc 429 (hết quota)
  - Twitter rate-limit lâu hơn 30 phút
  - Bot crash (cùng với stack trace)
- **Throttled**: cùng 1 lỗi không spam — max 1 alert / loại lỗi / giờ.

Cấu hình bot Telegram: hướng dẫn ở `guides/02-get-telegram-token.md` (3 phút setup qua @BotFather).

---

## 6. Auto-start khi máy boot (Windows)

`npm run install-service` tạo 2 Scheduled Task:
- `TwitterCommentPack` — chạy khi đăng nhập user
- `TwitterCommentPack_Startup` — chạy khi boot máy (ngay cả trước khi login)

→ Server reboot, bot tự dậy, không cần đăng nhập tay. Idempotent — chạy lại lệnh không tạo task trùng.

Gỡ bằng:
```cmd
schtasks /Delete /TN TwitterCommentPack /F
schtasks /Delete /TN TwitterCommentPack_Startup /F
```

(Linux/macOS: hiện chưa có installer, dùng systemd/launchd thủ công hoặc PM2.)

---

## 7. HTTP client tự xây — không phụ thuộc rettiwt-api

Bot dùng client HTTP thuần được port từ các bot production đã chạy:

- **Tự generate `x-client-transaction-id`**: header bắt buộc của Twitter cho mọi request graphql, dùng package `x-client-transaction-id@0.2.0` đã được patch sẵn (`patches/` auto-apply qua `patch-package` postinstall).
- **POST SearchTimeline đúng cách**: Twitter chuyển SearchTimeline từ GET sang POST, bot xử lý đúng (nhiều lib third-party còn sai).
- **Parse cả `core` lẫn `legacy` field**: Twitter rolling-update response shape, bot đọc cả 2 đường để không break khi API thay đổi.
- **Override queryId qua env**: Twitter rotate queryId mỗi vài tuần, bạn chỉ cần set `TWITTER_SEARCH_QUERY_ID=<new_id>` mà không cần rebuild.

---

## 8. Storage & dedup

- **SQLite local** (`data/state.db`) qua `better-sqlite3`:
  - `commented(tweet_id, ts)` — không bao giờ comment trùng tweet
  - `errors(ts, code, msg)` — log lỗi để debug
  - `meta(key, value)` — campaign state, last-seen-tweet
- **Atomic write**: config được ghi qua temp file + rename → không corrupt nếu crash giữa chừng.
- **Backup-friendly**: copy nguyên thư mục `data/` là đủ để khôi phục state.

---

## 9. Logs

- `data/run.log` — main activity log, JSON line per event
- `data/error.log` — chỉ lỗi
- Watch real-time:
  - Windows: `Get-Content data/run.log -Wait`
  - Linux/macOS: `tail -f data/run.log`
- **Không log secrets**: cookies, API key bị mask `***` trước khi ghi log.

---

## 10. Bảo mật

- `data/config.json`, `data/cookies.json`, `*.log`, `node_modules/` đều gitignored — không bao giờ commit lên git.
- Cookies lưu ở local file, không gửi đi đâu ngoài Twitter.
- API key chỉ gửi đến đúng provider bạn chọn.
- Không có telemetry, không phone-home, không update server.
- Toàn bộ source ESM JavaScript trong `src/` — đọc được hết, audit được hết.

---

## 11. Hỗ trợ AI Coding Assistant

Repo có sẵn `CLAUDE.md` và `SETUP.md` viết theo format chuẩn cho:
- **Claude Code** (Anthropic)
- **Google Antigravity / Gemini Code Assist**
- **Cursor** (đọc được CLAUDE.md)

→ User chỉ cần clone repo và bảo AI: *"setup giúp tao theo CLAUDE.md"*. Agent sẽ đọc instruction, hỏi đúng 5 câu, ghi config thay user, chạy bot. Không cần biết Node.js cũng setup được.

---

## 12. Update & maintenance

- **Update code**: `git pull && npm install` (postinstall tự re-apply patch).
- **Cookies hết hạn** (~2–4 tuần): re-export bằng Cookie-Editor → `npm run setup` → chỉ làm Q1.
- **Twitter break HTTP client** (rare, ~1 lần / 2-3 tháng): xem alert Telegram, update queryId hoặc re-patch theo hướng dẫn ở GitHub issues.
- **Đổi style/persona/list/rate**: chạy lại `npm run setup`, bot tự reload lúc cycle tiếp theo.

---

## Tóm tắt quick-reference

| Câu hỏi | Lệnh / file |
|---|---|
| Bắt đầu? | `npm run setup` |
| Chạy ngay? | `npm start` |
| Auto-start boot? | `npm run install-service` |
| Xem log live? | `Get-Content data/run.log -Wait` |
| Đổi config? | `npm run setup` (giữ default cũ) |
| Cookies hết hạn? | Re-export → `npm run setup` Q1 |
| Bot không comment? | Check `data/error.log` + alert Telegram |
| Đổi AI provider? | `npm run setup` Q5 |
| Gỡ autostart? | `schtasks /Delete /TN TwitterCommentPack /F` |
| Uninstall hoàn toàn? | Xóa folder, xóa 2 scheduled task |

Chi tiết từng bước trong thư mục [`guides/`](guides/).
