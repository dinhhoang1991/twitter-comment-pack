/**
 * Minimal Telegram alert sender.
 */
export async function sendAlert(token, chatId, text) {
  if (!token || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      // swallow
    }
  } catch {
    // swallow — never crash on telegram errors
  }
}
