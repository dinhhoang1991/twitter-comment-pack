/**
 * Multi-provider AI comment generator.
 * Supports: deepseek, openai, anthropic, grok. All via fetch — no SDK deps.
 */
import { isFollowBackRequest, followBackReply, detectLanguage } from './language.mjs';

const LANG_INSTRUCTION = {
  en: 'Write the reply in English.',
  vi: 'Write the reply in Vietnamese.',
  ja: '日本語で返信を書いてください。',
  ko: '한국어로 답글을 작성하세요。',
  zh: '请用中文（简体）写回复。',
};

const SENTIMENT_KEYWORDS = {
  bullish: ['🚀','pump','moon','buy','long','bullish','green','ath','breakout','tăng','x10','x100','sắp bay','sắp pump','gems','alpha','100x','gấp','mua','lên'],
  bearish: ['dump','crash','short','bearish','red','rug','scam','giảm','sập','xuống','bán','cut loss','-','red dildo'],
  technical: ['chart','pattern','support','resistance','rsi','macd','volume','ema','ma','fib','breakout','trendline','candlestick'],
  question: ['?','ai biết','nên mua','how to','what is','anyone','help','giúp','hỏi','là gì','có nên','khi nào','ở đâu'],
};

function analyzeSentiment(text) {
  const lower = text.toLowerCase();
  let bullish = 0, bearish = 0, technical = 0, question = 0;
  for (const w of SENTIMENT_KEYWORDS.bullish) if (lower.includes(w)) bullish++;
  for (const w of SENTIMENT_KEYWORDS.bearish) if (lower.includes(w)) bearish++;
  for (const w of SENTIMENT_KEYWORDS.technical) if (lower.includes(w)) technical++;
  for (const w of SENTIMENT_KEYWORDS.question) if (lower.includes(w)) question++;
  if (question > 0) return 'question';
  if (technical > 1) return 'technical';
  if (bullish > bearish) return 'bullish';
  if (bearish > bullish) return 'bearish';
  return 'neutral';
}

const PERSONA_MAP = {
  bullish: [
    'crypto trader who loves technical analysis and chart patterns',
    'degen yield farmer always hunting the next 100x gem',
    'Vietnam crypto enthusiast who believes SE Asia will lead the next bull run',
  ],
  bearish: [
    'cautious investor who only buys during bear markets and holds long term',
    'smart contract dev who sees through hype and values real utility',
  ],
  technical: [
    'crypto trader who loves technical analysis and chart patterns',
    'smart contract dev who sees through hype and values real utility',
  ],
  question: [
    'smart contract dev who sees through hype and values real utility',
    'crypto newbie asking genuine questions and learning from the community',
  ],
  neutral: [
    'crypto trader who loves technical analysis and chart patterns',
    'degen yield farmer always hunting the next 100x gem',
    'cautious investor who only buys during bear markets and holds long term',
    'crypto newbie asking genuine questions and learning from the community',
    'NFT collector obsessed with floor prices and rarity traits',
    'Vietnam crypto enthusiast who believes SE Asia will lead the next bull run',
    'smart contract dev who sees through hype and values real utility',
  ],
};

export function selectPersona(tweetText, availablePersonas) {
  const personas = availablePersonas?.length ? availablePersonas : PERSONA_MAP.neutral;
  const sentiment = analyzeSentiment(tweetText);
  const candidates = PERSONA_MAP[sentiment] || PERSONA_MAP.neutral;
  const valid = candidates.filter(p => personas.includes(p));
  const pool = valid.length ? valid : personas;
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildPrompt({ tweetText, lang, style, author }) {
  const styleLine = style && style.trim()
    ? `Style/persona: ${style.trim()}`
    : 'Style: human, casual, natural — not robotic.';
  const authorLine = author ? `You are replying to @${author}. ` : '';
  const sentiment = analyzeSentiment(tweetText);
  const sentimentHint = sentiment === 'bullish' ? 'Match the hype — be excited but not over-the-top.'
    : sentiment === 'bearish' ? 'Be empathetic and cautious — share the concern without spreading FUD.'
    : sentiment === 'question' ? 'Be genuinely helpful — answer the question if you can, or ask a clarifying follow-up.'
    : sentiment === 'technical' ? 'Add technical depth — mention a specific indicator or pattern if relevant.'
    : '';
  return `${authorLine}You are a real Twitter user leaving a comment on a tweet. Your comment must be:
- 1-2 sentences max (under 200 characters)
- Human and natural, NOT robotic or AI-sounding
- Contextually appropriate to the tweet (funny, supportive, insightful, or curious)
- No hashtags, no URLs, minimal emoji
${sentimentHint ? `- ${sentimentHint}\n` : ''}- End with a natural question or call-to-action that sparks engagement (what do you think?, agree?, etc.)
- End with a natural invitation to connect — suggest building a relationship, not just following. In Vietnamese use creative phrases like: "cùng kết nối nhé", "theo dõi nhau cùng phát triển", "hãy theo dõi mình lại nhé". In English use: "let's connect", "would love to follow each other", "let's grow together", "connect with fellow traders". NEVER use the words "follow back", "fl lại", "follow lại" — those sound desperate and robotic. Make it feel like a genuine networking invitation, not a transaction. Mix it up, don't repeat the same phrase.
- CRITICAL LANGUAGE RULE: You MUST reply in the SAME language as the tweet. Vietnamese tweet → Vietnamese reply. English tweet → English reply. This rule OVERRIDES everything else including style preferences. Never mix or switch languages.
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

async function callGrok({ apiKey, model, prompt }) {
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || 'grok-3',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
      temperature: 0.9,
    }),
  });
  if (!res.ok) throw new Error(`Grok HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content || '').trim();
}

export async function generateComment({ tweetText, lang, style, ai, author }) {
  if (isFollowBackRequest(tweetText)) {
    return followBackReply(lang);
  }
  const resolvedLang = (lang === 'auto') ? detectLanguage(tweetText) : (lang || 'en');
  const prompt = buildPrompt({ tweetText, lang: resolvedLang, style, author });
  const provider = (ai.provider || 'deepseek').toLowerCase();
  let text = '';
  if (provider === 'deepseek') text = await callDeepseek({ apiKey: ai.apiKey, model: ai.model, prompt });
  else if (provider === 'openai') text = await callOpenAI({ apiKey: ai.apiKey, model: ai.model, prompt });
  else if (provider === 'anthropic') text = await callAnthropic({ apiKey: ai.apiKey, model: ai.model, prompt });
  else if (provider === 'grok' || provider === 'xai') text = await callGrok({ apiKey: ai.apiKey, model: ai.model, prompt });
  else throw new Error(`Unknown AI provider: ${provider}`);

  if (!text) throw new Error('AI returned empty comment');
  return text.replace(/^[\"'`]+|[\"'`]+$/g, '').trim();
}
