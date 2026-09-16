/** 检索页：全文检索 15,192 篇文章摘要 + 筛选。 */

import { h } from '../lib/dom';
import { loadIndex } from '../lib/data';
import { highlight, n, sectionLabel } from '../lib/format';
import { createSearchEngine, type SearchEngine } from '../search/client';
import type { IndexFile, Manifest, SearchHit, Section } from '../lib/types';

let engine: SearchEngine | null = null;

function getEngine(manifest: Manifest): SearchEngine {
  engine ??= createSearchEngine(import.meta.env.BASE_URL || '/', manifest.dates);
  return engine;
}

interface Filters {
  q: string;
  category: string;
  section: string;
  from: string;
  to: string;
}

/** 首屏兜底检索：只用索引里的标题 + 摘要开头，无需等待全文索引。 */
function searchIndex(index: IndexFile, filters: Filters, limit: number): { hits: SearchHit[]; total: number } {
  const terms = filters.q.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { hits: [], total: 0 };

  const hits: SearchHit[] = [];
  for (const row of index.rows) {
    const [id, date, category, section, title, lead] = row;
    if (filters.category && category !== filters.category) continue;
    if (filters.section && section !== filters.section) continue;
    if (filters.from && date < filters.from) continue;
    if (filters.to && date > filters.to) continue;

    const hay = `${title}\n${lead}`.toLowerCase();
    let ok = true;
    for (const term of terms) {
      if (!hay.includes(term)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const titleLower = title.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (titleLower.includes(term)) score += 20;
    }
    hits.push({ id, date, category, section: section as Section, title, snippet: lead, score });
  }

  hits.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1));
  return { hits: hits.slice(0, limit), total: hits.length };
}

function resultRow(hit: SearchHit, q: string, manifest: Manifest): HTMLElement {
  const name = manifest.categories.find((c) => c.key === hit.category)?.name ?? hit.category;
  return h(
    'article',
    { class: 'result' },
    h('h3', { class: 'result__title' }, hit.title),
    h(
      'div',
      { class: 'result__meta' },
      h('span', {}, hit.date),
      h('a', { href: `#/domain/${encodeURIComponent(hit.category)}` }, name),
      h('span', {}, sectionLabel(hit.section)),
      h('a', { href: `#/report/${hit.date}` }, '查看该期'),
    ),
    h('p', { class: 'result__summary' }, highlight(hit.snippet, q)),
  );
}

export async function renderSearch(manifest: Manifest, initialQuery: string): Promise<HTMLElement> {
  const index = await loadIndex();
  const search = getEngine(manifest);

  const filters: Filters = { q: initialQuery, category: '', section: '', from: '', to: '' };

  const input = h('input', {
    class: 'search-input',
    type: 'search',
    placeholder: '搜索技术、公司、指标…（空格分隔多个关键词，按 AND 匹配）',
    value: filters.q,
    autofocus: '',
    'aria-label': '检索关键词',
  }) as HTMLInputElement;

  const categorySelect = h(
    'select',
    { 'aria-label': '按领域筛选' },
    h('option', { value: '' }, '全部领域'),
    ...manifest.categories.map((meta) => h('option', { value: meta.key }, `${meta.name}（${n(meta.article_count)}）`)),
  ) as HTMLSelectElement;

  const sectionSelect = h(
    'select',
    { 'aria-label': '按板块筛选' },
    h('option', { value: '' }, '全部板块'),
    h('option', { value: 'regular' }, '普通推文'),
    h('option', { value: 'paper' }, '论文推荐'),
  ) as HTMLSelectElement;

  const fromInput = h('input', { type: 'date', 'aria-label': '起始日期', min: manifest.dates[0], max: manifest.dates[manifest.dates.length - 1] }) as HTMLInputElement;
  const toInput = h('input', { type: 'date', 'aria-label': '结束日期', min: manifest.dates[0], max: manifest.dates[manifest.dates.length - 1] }) as HTMLInputElement;

  const statusText = h('span', {}, '正在建立全文索引…');
  const progressBar = h('div', { class: 'progress__bar', style: { width: '0%' } });
  const counter = h('span', {}, '');

  const metaRow = h(
    'div',
    { class: 'result-meta' },
    h('span', {}, statusText),
    h('div', { class: 'progress', style: { maxWidth: '220px' } }, progressBar),
    counter,
  );

  const resultsHost = h('div', {});

  let timer = 0;
  let runId = 0;

  async function run(): Promise<void> {
    const current = ++runId;
    const q = filters.q.trim();

    if (!q) {
      resultsHost.replaceChildren(
        h('div', { class: 'empty' }, '输入关键词开始检索。可试试「KV Cache」「存内计算」「HBM」「光互连」。'),
      );
      counter.textContent = '';
      return;
    }

    const state = search.state();
    let hits: SearchHit[];
    let total: number;

    if (state.status === 'ready') {
      const result = await search.search({
        q,
        categories: filters.category ? [filters.category] : undefined,
        sections: filters.section ? [filters.section] : undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        limit: 100,
      });
      hits = result.hits;
      total = result.total;
    } else {
      const result = searchIndex(index, filters, 100);
      hits = result.hits;
      total = result.total;
    }

    if (current !== runId) return;

    counter.textContent = total > hits.length ? `显示前 ${hits.length} / 共 ${total} 条` : `共 ${total} 条`;

    if (hits.length === 0) {
      resultsHost.replaceChildren(h('div', { class: 'empty' }, '没有匹配的结果，试试更短的关键词或放宽筛选。'));
      return;
    }
    resultsHost.replaceChildren(...hits.map((hit) => resultRow(hit, q, manifest)));
  }

  function schedule(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), 180);
  }

  input.addEventListener('input', () => {
    filters.q = input.value;
    schedule();
  });
  for (const [element, key] of [
    [categorySelect, 'category'],
    [sectionSelect, 'section'],
    [fromInput, 'from'],
    [toInput, 'to'],
  ] as const) {
    element.addEventListener('change', () => {
      filters[key] = element.value;
      schedule();
    });
  }

  const reset = h(
    'button',
    {
      class: 'filter-pill',
      type: 'button',
      onclick: () => {
        filters.category = '';
        filters.section = '';
        filters.from = '';
        filters.to = '';
        categorySelect.value = '';
        sectionSelect.value = '';
        fromInput.value = '';
        toInput.value = '';
        schedule();
      },
    },
    '清除筛选',
  );

  search.onState((state) => {
    if (state.status === 'ready') {
      statusText.textContent = `全文索引就绪（${n(state.count)} 篇）`;
      progressBar.style.width = '100%';
      void run();
    } else if (state.status === 'failed') {
      statusText.textContent = '全文索引不可用，当前仅检索标题与摘要开头';
      progressBar.style.width = '0%';
      void run();
    } else {
      statusText.textContent = `正在建立全文索引 ${state.loaded}/${state.total} 期…`;
      progressBar.style.width = `${Math.round((state.loaded / Math.max(state.total, 1)) * 100)}%`;
    }
  });

  const page = h(
    'div',
    { class: 'container' },
    h(
      'div',
      { class: 'page-head' },
      h('span', { class: 'eyebrow' }, '全文检索'),
      h('h1', { class: 'page-title' }, '检索文章摘要'),
      h(
        'p',
        { class: 'page-lede' },
        `共 ${n(manifest.article_count)} 篇文章摘要。全文索引在后台建立，建立期间先按标题与摘要开头匹配。`,
      ),
    ),
    h('div', { class: 'search-bar' }, input),
    h(
      'div',
      { class: 'filters' },
      categorySelect,
      sectionSelect,
      h('span', { class: 'muted' }, '从'),
      fromInput,
      h('span', { class: 'muted' }, '到'),
      toInput,
      reset,
    ),
    metaRow,
    resultsHost,
  );

  input.value = initialQuery;
  resultsHost.replaceChildren(h('div', { class: 'loading' }, '准备检索…'));
  if (initialQuery) schedule();
  else void run();

  return page;
}
