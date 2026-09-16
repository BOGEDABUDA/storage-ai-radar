/// <reference lib="webworker" />
/**
 * 全文检索 Worker：加载 42 个文章分片，在后台完成检索，
 * 避免 26 MB JSON 解析阻塞主线程。
 *
 * 中文用子串匹配（无需分词），多词查询按 AND 处理。
 */

import type { Article, SearchHit, Section } from '../lib/types';

interface Row {
  id: string;
  date: string;
  category: string;
  section: Section;
  title: string;
  summary: string;
  haystack: string;
}

interface LoadMessage {
  type: 'load';
  base: string;
  dates: string[];
}

interface QueryMessage {
  type: 'query';
  id: number;
  q: string;
  categories?: string[];
  sections?: string[];
  from?: string;
  to?: string;
  limit?: number;
}

type Incoming = LoadMessage | QueryMessage;

const rows: Row[] = [];
let ready = false;

function post(message: unknown): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
}

function snippetAround(summary: string, terms: string[]): string {
  if (!summary) return '';
  const lower = summary.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return summary.slice(0, 220);
  const start = Math.max(0, at - 60);
  const end = Math.min(summary.length, at + 160);
  return `${start > 0 ? '…' : ''}${summary.slice(start, end)}${end < summary.length ? '…' : ''}`;
}

function runQuery(message: QueryMessage): void {
  const terms = message.q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (terms.length === 0) {
    post({ type: 'results', id: message.id, hits: [], total: 0 });
    return;
  }

  const categories = message.categories?.length ? new Set(message.categories) : null;
  const sections = message.sections?.length ? new Set(message.sections) : null;
  const limit = message.limit ?? 200;

  const hits: (SearchHit & { sortKey: number })[] = [];

  for (const row of rows) {
    if (categories && !categories.has(row.category)) continue;
    if (sections && !sections.has(row.section)) continue;
    if (message.from && row.date < message.from) continue;
    if (message.to && row.date > message.to) continue;

    let ok = true;
    for (const term of terms) {
      if (!row.haystack.includes(term)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const titleLower = row.title.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (titleLower.includes(term)) score += 20;
      if (titleLower.startsWith(term)) score += 10;
    }
    // 命中次数（上限避免长文碾压）
    const first = terms[0]!;
    let count = 0;
    let cursor = row.haystack.indexOf(first);
    while (cursor >= 0 && count < 12) {
      count += 1;
      cursor = row.haystack.indexOf(first, cursor + first.length);
    }
    score += count;

    hits.push({
      id: row.id,
      date: row.date,
      category: row.category,
      section: row.section,
      title: row.title,
      snippet: snippetAround(row.summary, terms),
      score,
      sortKey: score * 1e8 + Number(row.date.replace(/-/g, '')),
    });
  }

  hits.sort((a, b) => b.sortKey - a.sortKey);
  const total = hits.length;
  const top = hits.slice(0, limit).map(({ sortKey: _sortKey, ...hit }) => hit);
  post({ type: 'results', id: message.id, hits: top, total });
}

async function load(message: LoadMessage): Promise<void> {
  const total = message.dates.length;
  for (let index = 0; index < total; index += 1) {
    const date = message.dates[index]!;
    try {
      const response = await fetch(`${message.base}data/articles/${date}.json`);
      if (!response.ok) throw new Error(String(response.status));
      const articles = (await response.json()) as Article[];
      for (const article of articles) {
        rows.push({
          id: article.id,
          date: article.date,
          category: article.category,
          section: article.section,
          title: article.title,
          summary: article.summary,
          haystack: `${article.title}\n${article.summary}`.toLowerCase(),
        });
      }
    } catch (error) {
      post({ type: 'warning', message: `${date} 分片加载失败：${String(error)}` });
    }
    post({ type: 'progress', loaded: index + 1, total });
  }
  ready = true;
  post({ type: 'ready', count: rows.length });
}

self.onmessage = (event: MessageEvent<Incoming>): void => {
  const message = event.data;
  if (message.type === 'load') {
    void load(message);
  } else if (message.type === 'query') {
    if (!ready) {
      post({ type: 'results', id: message.id, hits: [], total: 0, notReady: true });
      return;
    }
    runQuery(message);
  }
};
