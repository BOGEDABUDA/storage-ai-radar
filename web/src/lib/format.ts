/** 展示格式化工具。 */

const NUM = new Intl.NumberFormat('zh-CN');

export function n(value: number): string {
  return NUM.format(value);
}

/** 大数缩写：15192 → 1.52万 */
export function compact(value: number): string {
  if (value >= 10000) return `${(value / 10000).toFixed(2)}万`;
  return NUM.format(value);
}

/** 2026-09-14 → 2026年9月14日 */
export function cnDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${y}年${Number(m)}月${Number(d)}日`;
}

/** 2026-09-14 → 09/14 */
export function shortDate(iso: string): string {
  const parts = iso.split('-');
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : iso;
}

export function perspectiveLabel(p: string): string {
  return p === 'business' ? '商业' : p === 'technical' ? '学术/技术' : '主题';
}

export function sectionLabel(s: string): string {
  return s === 'paper' ? '论文推荐' : '普通推文';
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 转义正则元字符，用于把用户输入安全地拼进 RegExp。 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 高亮匹配片段，返回安全的 DOM 片段数组。 */
export function highlight(text: string, query: string, max = 260): DocumentFragment {
  const frag = document.createDocumentFragment();
  const trimmed = text.length > max ? `${text.slice(0, max)}…` : text;
  if (!query) {
    frag.appendChild(document.createTextNode(trimmed));
    return frag;
  }
  const re = new RegExp(`(${escapeRegExp(query)})`, 'gi');
  let last = 0;
  for (const match of trimmed.matchAll(re)) {
    const at = match.index ?? 0;
    if (at > last) frag.appendChild(document.createTextNode(trimmed.slice(last, at)));
    const mark = document.createElement('mark');
    mark.textContent = match[0];
    frag.appendChild(mark);
    last = at + match[0].length;
  }
  if (last < trimmed.length) frag.appendChild(document.createTextNode(trimmed.slice(last)));
  return frag;
}
