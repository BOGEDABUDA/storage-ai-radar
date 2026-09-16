/**
 * 学术论文推荐页。
 *
 * 数据来自 `论文推荐` 板块：媒体文章 → 抽出的论文身份 → arXiv 解析。
 * 展示时优先用 arXiv 的真实标题与英文原摘要；解析不到就退回抽出的论文名或媒体标题，
 * 并始终提供 Google Scholar / arXiv 搜索链接兜底。
 */

import { h } from '../lib/dom';
import { categoryColor, loadPapers } from '../lib/data';
import { n } from '../lib/format';
import { openAgent } from '../lib/agentBus';
import type { Manifest, Paper } from '../lib/types';

const MAX_CARDS = 120;

function paperCard(paper: Paper, manifest: Manifest): HTMLElement {
  const resolved = Boolean(paper.arxiv);
  const categoryNames = paper.categories.map(
    (key) => manifest.categories.find((c) => c.key === key)?.name ?? key,
  );
  const color = categoryColor(paper.primary_category);

  const meta: (Node | string)[] = [];
  if (paper.arxiv?.authors?.length) {
    meta.push(paper.arxiv.authors.slice(0, 3).join(', '));
    if (paper.arxiv.authors.length > 3) meta.push(' 等');
  } else if (paper.authors) {
    meta.push(paper.authors);
  }
  if (paper.venue) meta.push(` · ${paper.venue}`);
  const published = paper.arxiv?.published ?? (paper.year ? String(paper.year) : null);
  if (published) meta.push(` · ${published}`);

  const links = h(
    'div',
    { class: 'paper-links' },
    paper.links.arxiv_abs
      ? h('a', { class: 'paper-link paper-link--primary', href: paper.links.arxiv_abs, target: '_blank', rel: 'noopener noreferrer' }, 'arXiv 原文')
      : null,
    paper.links.arxiv_pdf
      ? h('a', { class: 'paper-link', href: paper.links.arxiv_pdf, target: '_blank', rel: 'noopener noreferrer' }, 'PDF')
      : null,
    h('a', { class: 'paper-link', href: paper.links.scholar, target: '_blank', rel: 'noopener noreferrer' }, 'Google Scholar'),
    h('a', { class: 'paper-link', href: paper.links.arxiv_search, target: '_blank', rel: 'noopener noreferrer' }, 'arXiv 搜索'),
    paper.primary_date ? h('a', { class: 'paper-link', href: `#/report/${paper.primary_date}` }, '查看该期日报') : null,
  );

  const abstractBlock = paper.arxiv?.abstract
    ? h(
        'details',
        { class: 'paper-abstract' },
        h('summary', {}, '英文原摘要'),
        h('p', {}, paper.arxiv.abstract),
      )
    : null;

  return h(
    'article',
    { class: 'paper-card', style: { '--cat': color } as unknown as CSSStyleDeclaration },
    h(
      'div',
      { class: 'paper-card__head' },
      h('h3', { class: 'paper-card__title' }, paper.title),
      resolved
        ? h('span', { class: 'chip paper-chip--ok' }, `arXiv:${paper.arxiv!.id}`)
        : h('span', { class: 'chip paper-chip--unresolved' }, '未匹配到 arXiv，用搜索链接'),
    ),
    meta.length > 0 ? h('div', { class: 'paper-card__meta' }, ...meta) : null,
    h(
      'div',
      { class: 'paper-card__tags' },
      ...categoryNames.map((name, index) =>
        h(
          'a',
          {
            class: 'chip',
            href: `#/domain/${encodeURIComponent(paper.categories[index]!)}`,
            style: { color: categoryColor(paper.categories[index]!) },
          },
          name,
        ),
      ),
      paper.dates.length > 1 ? h('span', { class: 'chip' }, `被推荐 ${paper.dates.length} 次`) : null,
    ),
    h('p', { class: 'paper-card__summary' }, paper.summary || '（该条源摘要为空）'),
    abstractBlock,
    links,
  );
}

export async function renderPapers(manifest: Manifest): Promise<HTMLElement> {
  const file = await loadPapers();
  const papers = file.papers;

  if (papers.length === 0) {
    return h(
      'div',
      { class: 'container' },
      h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, '学术论文推荐')),
      h('div', { class: 'empty' }, '尚未生成论文数据，请先运行 python3 -m pipeline.build_papers'),
    );
  }

  const state = { query: '', category: '', resolvedOnly: false, expanded: false };
  const listHost = h('div', { class: 'paper-list' });
  const counter = h('span', { class: 'muted' });

  function visible(): Paper[] {
    const query = state.query.trim().toLowerCase();
    return papers.filter((paper) => {
      if (state.resolvedOnly && !paper.arxiv) return false;
      if (state.category && !paper.categories.includes(state.category)) return false;
      if (query) {
        const haystack = `${paper.title}\n${paper.report_title}\n${paper.summary}\n${paper.paper_title}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }

  function render(): void {
    const matched = visible();
    const shown = state.expanded ? matched : matched.slice(0, MAX_CARDS);
    counter.textContent =
      matched.length > shown.length
        ? `显示 ${shown.length} / 共 ${matched.length} 篇`
        : `共 ${matched.length} 篇`;

    listHost.replaceChildren();
    if (shown.length === 0) {
      listHost.appendChild(h('div', { class: 'empty' }, '没有符合条件的论文。'));
      return;
    }
    for (const paper of shown) listHost.appendChild(paperCard(paper, manifest));
    if (matched.length > shown.length) {
      listHost.appendChild(
        h(
          'button',
          {
            class: 'filter-pill',
            type: 'button',
            style: { marginTop: 'var(--space-4)' },
            onclick: () => {
              state.expanded = true;
              render();
            },
          },
          `展开剩余 ${matched.length - shown.length} 篇（共 ${matched.length} 篇，页面可能变长）`,
        ),
      );
    }
  }

  const searchInput = h('input', {
    class: 'search-input',
    type: 'search',
    placeholder: '搜索论文标题、媒体标题、摘要…',
    'aria-label': '搜索论文',
  }) as HTMLInputElement;
  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    render();
  });

  const categorySelect = h(
    'select',
    { 'aria-label': '按领域筛选' },
    h('option', { value: '' }, '全部领域'),
    ...manifest.categories.map((meta) => {
      const count = papers.filter((p) => p.categories.includes(meta.key)).length;
      return h('option', { value: meta.key }, `${meta.name}（${count}）`);
    }),
  ) as HTMLSelectElement;
  categorySelect.addEventListener('change', () => {
    state.category = categorySelect.value;
    render();
  });

  const resolvedToggle = h(
    'button',
    {
      class: 'filter-pill',
      type: 'button',
      'aria-pressed': 'false',
      onclick: () => {
        state.resolvedOnly = !state.resolvedOnly;
        resolvedToggle.setAttribute('aria-pressed', String(state.resolvedOnly));
        render();
      },
    },
    '只看已匹配到 arXiv',
  );

  const stats = file.stats;

  const page = h(
    'div',
    { class: 'container' },
    h(
      'div',
      { class: 'page-head' },
      h('span', { class: 'eyebrow' }, '学术论文推荐'),
      h('h1', { class: 'page-title' }, '各领域学术论文'),
      h(
        'p',
        { class: 'page-lede' },
        `从 42 期日报的「论文推荐」板块共 `,
        h('strong', {}, n(stats.paper_entries)),
        ` 条媒体摘要中，抽出 `,
        h('strong', {}, n(stats.unique_papers)),
        ` 篇论文；其中 `,
        h('strong', {}, n(stats.resolved)),
        ` 篇已在 arXiv 匹配到原文（含英文摘要），`,
        `其余提供 Google Scholar 与 arXiv 搜索链接。`,
      ),
      h(
        'div',
        { class: 'filters', style: { marginTop: 'var(--space-3)', marginBottom: 0 } },
        h(
          'button',
          {
            class: 'filter-pill agent-deep',
            type: 'button',
            onclick: () => openAgent('这些论文里，哪些和存储系统最相关？请给出理由。'),
          },
          '✦ 让 Agent 梳理这批论文',
        ),
      ),
    ),
    h('div', { class: 'search-bar' }, searchInput, categorySelect, resolvedToggle),
    h('div', { class: 'result-meta' }, counter),
    listHost,
  );

  render();
  return page;
}
