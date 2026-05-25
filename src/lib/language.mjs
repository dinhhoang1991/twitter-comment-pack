/**
/** Detect language based on Unicode character ranges.
  * Returns one of: vi, en, ja, ko, zh
  */
export function detectLanguage(text) {
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'ja';
  if (/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(text)) return 'ko';
  if (/[\u4E00-\u9FFF]/.test(text)) {
    const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
    if (nonAscii / Math.max(text.length, 1) > 0.3) return 'zh';
  }
  // Vietnamese: a-z with diacritics (ă, â, ê, ô, ơ, ư, đ, etc.)
  if (/[\u00C0-\u024F\u1E00-\u1EFF]/.test(text) || /[ăâêôơưđĂÂÊÔƠƯĐ]/.test(text)) return 'vi';
  return 'en';
}

export function isFollowBackRequest(text) {
  return (
    /follow\s*(back|me|each\s*other)|f4f|followback|#followback/i.test(text) ||
    /フォロバ|相互フォロー|フォローして|フォロバ待ち/.test(text) ||
    /맞팔|팔로우\s*해|팔로백|맞팔해/.test(text) ||
    /互粉|回粉|关注回|互关/.test(text)
  );
}

export function followBackReply(lang) {
  if (lang === 'ja') return 'フォロバお願いします';
  if (lang === 'ko') return '맞팔 부탁드려요';
  if (lang === 'zh') return '互相关注吧！';
  if (lang === 'vi') return 'Quan tâm lại mình nhé!';
  return 'Follow me back';
}
