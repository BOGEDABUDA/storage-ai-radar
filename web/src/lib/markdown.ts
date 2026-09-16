/**
 * 极简 Markdown 渲染器（零依赖）。
 *
 * 只支持 Agent 回答里实际会出现的子集：标题、粗体、行内代码、围栏代码块、
 * 无序/有序列表、表格、链接、以及 [n] 形式引用。
 * 全部通过 DOM API 构造，先转义文本，避免把模型输出当 HTML 注入。
 */

function escapeText(text: string): string {
  return text;
}

function inline(text: string, onCitation?: (n: number) => void): DocumentFragment {
  const frag = document.createDocumentFragment();
  // 依次匹配：行内代码、粗体、链接、引用标记
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]\d][^\]]*\]\([^)]+\))|(\[\d+(?:\]\[\d+)*\])/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) frag.appendChild(document.createTextNode(text.slice(last, at)));
    const token = match[0];

    if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      frag.appendChild(code);
    } else if (token.startsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      frag.appendChild(strong);
    } else if (token.startsWith('[') && token.includes('](')) {
      const close = token.indexOf('](');
      const label = token.slice(1, close);
      const url = token.slice(close + 2, -1);
      const link = document.createElement('a');
      link.textContent = label;
      if (/^https?:\/\//.test(url)) {
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      } else {
        link.href = url;
      }
      frag.appendChild(link);
    } else {
      // [3] 或 [3][4][5] 引用：合并成一个上标组并用逗号分隔，
      // 否则连续引用会渲染成 "345" 这样无法阅读的数字串
      const numbers = token.match(/\d+/g) ?? [];
      if (numbers.length > 0) {
        const sup = document.createElement('sup');
        sup.className = 'cite-group';
        numbers.forEach((num, index) => {
          if (index > 0) sup.appendChild(document.createTextNode(','));
          const span = document.createElement('span');
          span.className = 'cite cite--link';
          span.textContent = num;
          span.title = `查看来源 ${num}`;
          span.addEventListener('click', () => onCitation?.(Number(num)));
          sup.appendChild(span);
        });
        frag.appendChild(sup);
      }
    }
    last = at + token.length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

export function renderMarkdown(text: string, onCitation?: (n: number) => void): DocumentFragment {
  const root = document.createDocumentFragment();
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let index = 0;

  const flushParagraph = (buffer: string[]): void => {
    if (buffer.length === 0) return;
    const p = document.createElement('p');
    p.appendChild(inline(buffer.join(' '), onCitation));
    root.appendChild(p);
    buffer.length = 0;
  };

  const buffer: string[] = [];

  while (index < lines.length) {
    const line = lines[index]!;

    // 围栏代码块
    if (line.trimStart().startsWith('```')) {
      flushParagraph(buffer);
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length && !lines[index]!.trimStart().startsWith('```')) {
        codeLines.push(lines[index]!);
        index += 1;
      }
      index += 1;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = codeLines.join('\n');
      pre.appendChild(code);
      root.appendChild(pre);
      continue;
    }

    // 标题
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(buffer);
      const level = Math.min(heading[1]!.length + 2, 6);
      const el = document.createElement(`h${level}`);
      el.appendChild(inline(heading[2]!, onCitation));
      root.appendChild(el);
      index += 1;
      continue;
    }

    // 表格
    if (line.trim().startsWith('|') && lines[index + 1]?.includes('---')) {
      flushParagraph(buffer);
      const parseRow = (row: string): string[] =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim());

      const table = document.createElement('table');
      table.className = 'md-table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const cell of parseRow(line)) {
        const th = document.createElement('th');
        th.appendChild(inline(cell, onCitation));
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      index += 2;

      const tbody = document.createElement('tbody');
      while (index < lines.length && lines[index]!.trim().startsWith('|')) {
        const tr = document.createElement('tr');
        for (const cell of parseRow(lines[index]!)) {
          const td = document.createElement('td');
          td.appendChild(inline(cell, onCitation));
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
        index += 1;
      }
      table.appendChild(tbody);
      root.appendChild(table);
      continue;
    }

    // 列表
    const bullet = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph(buffer);
      const ordered = /\d/.test(bullet[1]!);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const item = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(lines[index]!);
        if (!item) break;
        const li = document.createElement('li');
        li.appendChild(inline(item[2]!, onCitation));
        list.appendChild(li);
        index += 1;
      }
      root.appendChild(list);
      continue;
    }

    if (!line.trim()) {
      flushParagraph(buffer);
      index += 1;
      continue;
    }

    buffer.push(line.trim());
    index += 1;
  }

  flushParagraph(buffer);
  return root;
}

export { escapeText };
