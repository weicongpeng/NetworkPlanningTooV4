/** 把纯文本切成「普通片段 / 可点击网址」，供 RN Text 嵌套渲染。 */
export interface TextPart {
  text: string
  url?: string
}

const URL_RE = /(https?:\/\/[^\s<>"'`]+|www\.[^\s<>"'`]+)/gi;
const TRAILING_PUNCTUATION = /[.,;:!?，。；：！？、)）\]】>]+$/;

export function splitLinks(text: string): TextPart[] {
  if (!text) return [];
  const parts: TextPart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  URL_RE.lastIndex = 0;

  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push({ text: text.slice(lastIndex, match.index) });
    let raw = match[0];
    let suffix = '';
    const trailing = raw.match(TRAILING_PUNCTUATION);
    if (trailing) {
      raw = raw.slice(0, -trailing[0].length);
      suffix = trailing[0];
    }
    if (raw) {
      parts.push({
        text: raw,
        url: raw.toLowerCase().startsWith('www.') ? `https://${raw}` : raw,
      });
    } else {
      parts.push({ text: match[0] });
    }
    if (suffix) parts.push({ text: suffix });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex) });
  return parts.length ? parts : [{ text }];
}
