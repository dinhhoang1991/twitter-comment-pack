/**
 * Multi-provider AI comment generator.
 * Supports: deepseek, openai, anthropic. All via fetch — no SDK deps.
 */
import { isFollowBackRequest, followBackReply } from './language.mjs';

const LANG_INSTRUCTION = {
  en: 'Write the reply in English.',
  ja: '日本語で返信を書いてください。',
  ko: '한국어로 답글을 작성하세요.',
  zh: '请用中文（简体）写回复。',
};

function buildPrompt({ tweetText, lang, style }) {
  const styleLine = style && style.trim()
    ? `Style/persona: ${style.trim()}`
    : 'Style: human, casual, natural — not robotic.';
  return `You are a real Twitter user leaving a comment on a tweet. Your comment must be:
- 1-2 sentences max (under 200 characters)
- Human and natural, NOT robotic or AI-sounding
- Contextually appropriate to the tweet (funny, supportive, insightful, or curious)
- No hashtags, no URLs, minimal emoji
- ${LANG_INSTRUCTION[lang] || LANG_INSTRUCTION.en}
- ${styleLine}

Tweet content:
"${tweetText.slice(0, 500)}"

Reply with ONLY the comment text. Nothing else.`;
}

async function callDeepseek({ apiKey, model, prompt }) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
      temperature: 0.95,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content || '').trim();
}

async function callOpenAI({ apiKey, model, prompt }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
      temperature: 0.95,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content || '').trim();
}

async function callAnthropic({ apiKey, model, prompt }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-haiku-4-5',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const block = (data?.content || []).find((b) => b.type === 'text');
  return (block?.text || '').trim();
}

export async function generateComment({ tweetText, lang, style, ai }) {
  if (isFollowBackRequest(tweetText)) {
    return followBackReply(lang);
  }
  const prompt = buildPrompt({ tweetText, lang, style });
  const provider = (ai.provider || 'deepseek').toLowerCase();
  let text = '';
  if (provider === 'deepseek') text = await callDeepseek({ apiKey: ai.apiKey, model: ai.model, prompt });
  else if (provider === 'openai') text = await callOpenAI({ apiKey: ai.apiKey, model: ai.model, prompt });
  else if (provider === 'anthropic') text = await callAnthropic({ apiKey: ai.apiKey, model: ai.model, prompt });
  else throw new Error(`Unknown AI provider: ${provider}`);

  if (!text) throw new Error('AI returned empty comment');
  // Strip surrounding quotes if model added them
  return text.replace(/^["'`]+|["'`]+$/g, '').trim();
}
