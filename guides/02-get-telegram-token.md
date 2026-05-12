# Telegram bot token + chat ID

## Tiếng Việt

### Bước 1 — Tạo bot

1. Mở Telegram, tìm `@BotFather`.
2. Gõ `/newbot`. BotFather hỏi:
   - Tên hiển thị (vd: `My Comment Bot`)
   - Username (phải kết thúc bằng `bot`, vd: `my_comment_alert_bot`)
3. BotFather trả về **bot token** dạng `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ`. Copy lưu lại.

### Bước 2 — Lấy chat ID

1. Mở chat với bot mới tạo (search username), gửi tin nhắn bất kỳ (vd: `hi`).
2. Mở browser, vào URL:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
   (thay `<TOKEN>` bằng token vừa copy)
3. Tìm trong JSON trả về: `"chat":{"id":123456789, ...}`. Số đó là chat ID.

### Bước 3 — Paste vào wizard

Wizard sẽ hỏi token và chat ID lần lượt. Nếu không muốn dùng Telegram, để trống ở câu hỏi token là xong.

### Tip — gửi vào group thay vì DM

Add bot vào group → gửi `/start@<bot_username>` trong group → kiểm tra getUpdates → chat ID sẽ là số ÂM (vd `-1001234567890`).

## English

1. Open Telegram, search `@BotFather`, send `/newbot`. Follow prompts. Save the bot token.
2. Send your bot any message (e.g. `hi`).
3. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` — find `"chat":{"id":...}`.
4. Paste both into the wizard. Skip by leaving token blank.

For group alerts: add bot to group, post `/start@<bot_username>` there. The chat id will be negative.
