/**
 * 检索层：FTS5 全文检索 + 原始正文按需读取 + 上下文组装。
 *
 * 设计要点：
 * - 中文用 FTS5 trigram，无需外部分词器
 * - trigram 对 <3 字符的词无法用索引，因此短词自动退化为 LIKE 扫描
 * - 原始正文不入库：按日期读取 articles/<date>/<account>/*.txt（只读），
 *   避免为 353 MB 语料再建一份 ~1.6 GB 的索引
 */

import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CONTEXT_BUDGET = 14000;

export function openIndex(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

export function indexStats(db) {
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return {
    generated_at: meta.generated_at ?? null,
    digests: Number(meta.digests ?? count('digests')),
    articles: Number(meta.articles ?? count('articles')),
  };
}

// 多字停用词/疑问词：用于把自然语言问句切回关键词。
// 只用多字词，避免误伤「存内计算」里的单字。
const STOP_PHRASES = [
  '有哪些', '是什么', '有什么', '怎么样', '为什么', '怎么', '如何', '哪些', '哪个', '什么',
  '请问', '告诉我', '介绍一下', '介绍', '说说', '总结', '分析', '比较', '给出', '列出',
  '近期', '最近', '目前', '现在', '进展', '情况', '动态', '一下', '关键', '数字', '数据',
  '以及', '这个', '那个', '我们', '他们', '可以', '能否', '是否', '有没有', '还有',
  '方面', '相关', '关于', '针对', '对于', '主要', '重点', '需要', '应该', '可能',
  '的区别', '的差异', '的关系', '的原因', '的现状', '的对比', '的优劣', '各自',
];
const STOP_RE = new RegExp(STOP_PHRASES.join('|'), 'g');
const TRAILING_PARTICLES = /[的了呢吗吧啊呀嘛]+$/;
const MAX_TERM = 14;

/** 把用户输入（可能是自然语言问句）拆成检索词。 */
export function parseTerms(query) {
  const tokens = String(query ?? '')
    .split(/[^\p{L}\p{N}+#.]+/u)
    .map((t) => t.trim())
    .filter(Boolean);

  const terms = [];
  for (const token of tokens) {
    // 先按停用词切分（「压缩近期有哪些进展」→「压缩」），再对每段按连接词切分
    // （「存内计算和近存加速」→ 两段）。仅当每段都 >=2 字时才采用连接词切分，
    // 避免把「饱和」「和谐」这类词切坏。
    for (const chunk of token.split(STOP_RE)) {
      let pieces = [chunk];
      const byConjunction = chunk.split(/[和与及或跟]/);
      if (byConjunction.length > 1 && byConjunction.every((piece) => piece.length >= 2)) {
        pieces = byConjunction;
      }
      for (let piece of pieces) {
        piece = piece.replace(/^[的了呢吗吧啊呀嘛]+/, '').replace(TRAILING_PARTICLES, '').trim();
        if (piece.length < 2 || piece.length > MAX_TERM) continue;
        if (/^\d+$/.test(piece)) continue; // 纯数字对检索没有区分度
        terms.push(piece);
      }
    }
  }
  const unique = [...new Set(terms)];
  return unique.slice(0, 6);
}

function ftsExpression(terms, any = false) {
  // 每个词包成短语，避免 trigram 把标点当语法
  const quoted = terms.map((t) => `"${t.replace(/"/g, '""')}"`);
  return quoted.join(any ? ' OR ' : ' AND ');
}

function canUseFts(terms) {
  // trigram 需要至少 3 个字符才能命中索引
  return terms.length > 0 && terms.every((t) => [...t].length >= 3);
}

function likeClause(terms, columns, any = false) {
  const one = (term) => `(${columns.map((c) => `${c} LIKE ?`).join(' OR ')})`;
  const where = any ? terms.map(one).join(' OR ') : terms.map(one).join(' AND ');
  const params = [];
  for (const term of terms) for (const _ of columns) params.push(`%${term}%`);
  return { where, params };
}

const ARTICLE_FIELDS = 'a.id, a.date, a.category, a.category_name, a.section, a.title, a.summary';
const DIGEST_FIELDS = 'd.id, d.date, d.category, d.category_name, d.perspective, d.topic, d.text, d.sources';

/** 用 OR 召回（多召回 4 倍），再按「命中了几个检索词」重排，最后截断。 */
function rankByCoverage(rows, terms, fields, limit) {
  const scored = rows.map((row) => {
    const haystack = fields.map((f) => String(row[f] ?? '')).join('\n').toLowerCase();
    const coverage = terms.reduce((sum, term) => (haystack.includes(term.toLowerCase()) ? sum + 1 : sum), 0);
    return { row, coverage };
  });
  // sort 是稳定的：覆盖度相同时保留 FTS5 的 bm25 排序
  scored.sort((a, b) => b.coverage - a.coverage);
  return scored.slice(0, limit).map((item) => item.row);
}

function runSearch({ db, terms, ftsTable, baseTable, alias, fields, fieldNames, filters, filterParams, limit }) {
  if (terms.length === 0) return [];
  const filterSql = filters.map((f) => ` AND ${f}`).join('');
  const overFetch = Math.max(limit * 4, 40);

  if (canUseFts(terms)) {
    const sql =
      `SELECT ${fields} FROM ${ftsTable} f JOIN ${baseTable} ${alias} ON ${alias}.id = f.id ` +
      `WHERE ${ftsTable} MATCH ?${filterSql} ORDER BY rank LIMIT ?`;
    const rows = db.prepare(sql).all(ftsExpression(terms, true), ...filterParams, overFetch);
    if (rows.length > 0) return rankByCoverage(rows, terms, fieldNames, limit);
  }

  const { where, params: likeParams } = likeClause(terms, fieldNames.map((n) => `${alias}.${n}`), true);
  const sql =
    `SELECT ${fields} FROM ${baseTable} ${alias} WHERE ${where}${filterSql} ` +
    `ORDER BY ${alias}.date DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...likeParams, ...filterParams, overFetch);
  return rankByCoverage(rows, terms, fieldNames, limit);
}

/** 检索文章摘要。 */
export function searchArticles(db, { q, category, from, to, limit = 30 } = {}) {
  const terms = parseTerms(q);
  const filters = [];
  const filterParams = [];
  if (category) {
    filters.push('a.category = ?');
    filterParams.push(category);
  }
  if (from) {
    filters.push('a.date >= ?');
    filterParams.push(from);
  }
  if (to) {
    filters.push('a.date <= ?');
    filterParams.push(to);
  }
  return runSearch({
    db,
    terms,
    ftsTable: 'articles_fts',
    baseTable: 'articles',
    alias: 'a',
    fields: ARTICLE_FIELDS,
    fieldNames: ['title', 'summary'],
    filters,
    filterParams,
    limit,
  });
}

/** 检索精选洞察。 */
export function searchDigests(db, { q, category, from, to, limit = 20 } = {}) {
  const terms = parseTerms(q);
  const filters = [];
  const filterParams = [];
  if (category) {
    filters.push('d.category = ?');
    filterParams.push(category);
  }
  if (from) {
    filters.push('d.date >= ?');
    filterParams.push(from);
  }
  if (to) {
    filters.push('d.date <= ?');
    filterParams.push(to);
  }
  return runSearch({
    db,
    terms,
    ftsTable: 'digests_fts',
    baseTable: 'digests',
    alias: 'd',
    fields: DIGEST_FIELDS,
    fieldNames: ['topic', 'text'],
    filters,
    filterParams,
    limit,
  });
}

/** 兼容旧调用点：召回本身就是 OR + 覆盖度重排，无需再退化。 */
export function searchWithFallback(db, opts) {
  const digests = searchDigests(db, { ...opts, limit: opts.digestLimit ?? 12 });
  const articles = searchArticles(db, { ...opts, limit: opts.articleLimit ?? 24 });
  return { digests, articles, relaxed: false };
}

/** 某实体相关的洞察与文章（用于点击图谱节点/领域后的深挖）。 */
export function entityContext(db, label, { limit = 12 } = {}) {
  const digests = searchDigests(db, { q: label, limit });
  let articles = searchArticles(db, { q: label, limit: limit * 2 });
  if (articles.length === 0) {
    // 多词实体（如 "DeepSeek V4.1 Flash"）退化为标题模糊匹配
    articles = db
      .prepare(
        `SELECT ${ARTICLE_FIELDS} FROM articles a WHERE a.title LIKE ? ORDER BY a.date DESC LIMIT ?`,
      )
      .all(`%${label}%`, limit * 2);
  }
  return { digests, articles };
}

/** 列出有原始正文的日期（倒序）。 */
export async function rawDates(sourceDir) {
  const dir = path.join(sourceDir, 'articles');
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
}

/**
 * 在原始正文里深挖：默认只扫描最近若干期，避免全量 353 MB 扫描。
 * 返回带上下文的命中片段。
 */
export async function deepSearch(sourceDir, { q, date, dates = 6, limit = 8 } = {}) {
  const terms = parseTerms(q);
  if (terms.length === 0) return [];
  const available = await rawDates(sourceDir);
  const scope = date ? [date] : available.slice(0, Math.max(1, dates));

  const hits = [];
  for (const day of scope) {
    const dayDir = path.join(sourceDir, 'articles', day);
    if (!existsSync(dayDir)) continue;
    let accounts;
    try {
      accounts = await readdir(dayDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const account of accounts) {
      if (!account.isDirectory()) continue;
      const accountDir = path.join(dayDir, account.name);
      let files;
      try {
        files = await readdir(accountDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.txt')) continue;
        let body;
        try {
          body = await readFile(path.join(accountDir, file), 'utf8');
        } catch {
          continue;
        }
        const haystack = body.toLowerCase();
        // 所有词都出现才算命中
        if (!terms.every((t) => haystack.includes(t.toLowerCase()))) continue;
        const first = terms[0].toLowerCase();
        const at = haystack.indexOf(first);
        const start = Math.max(0, at - 200);
        hits.push({
          date: day,
          account: account.name,
          title: file.replace(/\.txt$/, '').replace(/_\d{8}_\d{6}$/, ''),
          excerpt: body.slice(start, start + 700).replace(/\s+/g, ' ').trim(),
        });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}

/** 组装带编号引用的上下文，控制在预算内。 */
export function buildContext(digests, articles) {
  const blocks = [];
  let used = 0;

  for (const d of digests) {
    const text =
      `[洞察 ${d.date} · ${d.category_name} · ${d.perspective}] ${d.topic}\n${d.text}`;
    if (used + text.length > CONTEXT_BUDGET) break;
    used += text.length;
    blocks.push({ kind: 'digest', id: d.id, date: d.date, title: d.topic, category: d.category, text });
  }

  // 展示层去重：同一篇文章可能因被归入多个领域而检索出多条，
  // 归并成一条并把领域名合并，避免同一份内容占用两次上下文预算。
  const seen = new Map();
  for (const a of articles) {
    const key = `${a.date}|${String(a.title).replace(/[\s\u3000]+/g, '').toLowerCase()}`;
    const existing = seen.get(key);
    if (existing) {
      if (!existing.categoryNames.includes(a.category_name)) existing.categoryNames.push(a.category_name);
      existing.duplicated += 1;
      continue;
    }
    seen.set(key, { article: a, categoryNames: [a.category_name], duplicated: 1 });
  }

  for (const { article: a, categoryNames, duplicated } of seen.values()) {
    const summary = a.summary || '（该篇原文摘要为空）';
    const tag = a.section === 'paper' ? '论文推荐' : '普通推文';
    const dup = duplicated > 1 ? `（同期被 ${duplicated} 个领域收录）` : '';
    const text = `[文章 ${a.date} · ${categoryNames.join('/')} · ${tag}${dup}] ${a.title}\n${summary}`;
    if (used + text.length > CONTEXT_BUDGET) break;
    used += text.length;
    blocks.push({ kind: 'article', id: a.id, date: a.date, title: a.title, category: a.category, text });
  }

  const context = blocks.map((b, i) => `[${i + 1}] ${b.text}`).join('\n\n');
  return { context, blocks };
}

export const SYSTEM_PROMPT = `你是存储与 AI 基础设施领域的研究助理，为实验室同事做技术情报分析。

规则：
1. 只能依据【资料】回答，禁止编造。资料里没有的内容必须明确说「现有资料未覆盖」。
2. 每个事实性结论后面标注来源编号，格式如 [1]、[2][3]。不要只在末尾集中列引用。
3. 优先给出可量化信息（数值、倍数、时间、规格），保留原始单位。
4. 明确区分「产业/商业信号」与「学术/技术进展」。
5. 如果资料之间存在冲突或口径不一致，指出来，不要抹平。
6. 用中文回答，条理清晰，直接给结论，不要客套与重复问题。`;

export { CONTEXT_BUDGET };
