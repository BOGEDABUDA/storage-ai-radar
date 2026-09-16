/** 极简 DOM 构造工具：不引入任何前端框架。 */

export type Child = Node | string | number | null | undefined | false;

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

function applyAttrs(el: Element, attrs?: Record<string, unknown> | null): void {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') {
      el.setAttribute('class', String(value));
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (key === 'dataset') {
      for (const [dk, dv] of Object.entries(value as Record<string, unknown>)) {
        (el as HTMLElement).dataset[dk] = String(dv);
      }
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign((el as HTMLElement).style, value as Partial<CSSStyleDeclaration>);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

/** 创建 HTML 元素。 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, unknown> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

/** 创建 SVG 元素（SVG 必须用命名空间，createElement 不适用）。 */
export function s(
  tag: string,
  attrs?: Record<string, unknown> | null,
  ...children: Child[]
): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** 拼接 className，过滤空值。 */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
