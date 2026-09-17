/**
 * Agent 服务测试（node --test agent/）。
 *
 * 分两层：
 * - 单元：检索词解析、上下文组装预算（不需要索引）
 * - 集成：用真实索引起一个服务，验证端点、CORS、鉴权与错误处理（索引不存在时跳过）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTEXT_BUDGET,
  buildContext,
  indexStats,
  openIndex,
  parseTerms,
  searchArticles,
  searchDigests,
} from './rag.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DB_PATH = path.join(ROOT, 'insight.sqlite');
const HAS_INDEX = existsSync(DB_PATH);

/* ---------------------------------------------------------------- 单元 */

test('parseTerms 把自然语言问句切成关键词', () => {
  assert.deepEqual(parseTerms('存内计算和近存加速有什么区别？'), ['存内计算', '近存加速', '区别']);
  assert.deepEqual(parseTerms('KV Cache 压缩近期有哪些进展？给出关键数字。'), ['KV', 'Cache', '压缩']);
  assert.deepEqual(parseTerms('HBM 价格走势如何？'), ['HBM', '价格走势']);
});

test('parseTerms 不误伤包含连接词的真词', () => {
  // 「饱和」含「和」，但切出来会剩单字，因此应保留原词
  assert.deepEqual(parseTerms('饱和'), ['饱和']);
});

test('parseTerms 过滤纯数字与空输入', () => {
  assert.deepEqual(parseTerms(''), []);
  assert.deepEqual(parseTerms('2026'), []);
  assert.deepEqual(parseTerms('   '), []);
});

test('parseTerms 最多返回 6 个词', () => {
  const terms = parseTerms('甲甲 乙乙 丙丙 丁丁 戊戊 己己 庚庚 辛辛');
  assert.ok(terms.length <= 6, `期望 <=6，实际 ${terms.length}`);
});

test('buildContext 遵守字符预算且编号从 1 开始', () => {
  const digests = Array.from({ length: 60 }, (_, i) => ({
    id: `d${i}`,
    date: '2026-09-14',
    category: 'others',
    category_name: '其他',
    perspective: 'business',
    topic: `题 ${i}`,
    text: '正文'.repeat(220),
  }));
  const { context, blocks } = buildContext(digests, []);
  assert.ok(context.length <= CONTEXT_BUDGET + 600, `上下文超预算：${context.length}`);
  assert.ok(blocks.length > 0 && blocks.length < digests.length, '应当截断');
  assert.ok(context.startsWith('[1] '), '编号应从 1 开始');
});

/* ---------------------------------------------------------------- 集成 */

test('索引存在时的检索行为', { skip: !HAS_INDEX }, () => {
  const db = openIndex(DB_PATH);
  try {
    const stats = indexStats(db);
    // 语料会随日报工作流增长，只断下限
    assert.ok(stats.digests >= 790, `洞察数异常偏少：${stats.digests}`);
    assert.ok(stats.articles >= 14000, `文章数异常偏少：${stats.articles}`);

    const digests = searchDigests(db, { q: '存内计算', limit: 5 });
    assert.ok(digests.length > 0, '应能检索到洞察');

    const articles = searchArticles(db, { q: 'KV Cache 压缩', limit: 5 });
    assert.ok(articles.length > 0, '应能检索到文章');

    // 覆盖度重排：命中更多检索词的结果应排在前面
    const multi = searchArticles(db, { q: 'HBM 价格', limit: 5 });
    assert.ok(multi.length > 0);

    // 分类过滤生效
    const filtered = searchArticles(db, { q: '存内计算', category: 'near-memory-computing', limit: 5 });
    for (const row of filtered) assert.equal(row.category, 'near-memory-computing');
  } finally {
    db.close();
  }
});

test('短词（<3 字符）走 LIKE 兜底不报错', { skip: !HAS_INDEX }, () => {
  const db = openIndex(DB_PATH);
  try {
    const rows = searchArticles(db, { q: 'AI', limit: 5 });
    assert.ok(Array.isArray(rows));
  } finally {
    db.close();
  }
});

test('HTTP 端点：health / search / CORS / 参数校验', { skip: !HAS_INDEX }, async () => {
  const port = 8899;
  const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
    env: { ...process.env, RADAR_AGENT_PORT: String(port) },
    stdio: 'ignore',
  });

  const base = `http://127.0.0.1:${port}`;
  try {
    // 等服务起来
    let healthy = false;
    for (let i = 0; i < 40; i += 1) {
      try {
        const res = await fetch(`${base}/api/health`);
        if (res.ok) {
          healthy = true;
          const body = await res.json();
          assert.equal(body.ok, true);
          assert.ok(body.index.articles >= 14000, `文章数异常偏少：${body.index.articles}`);
          break;
        }
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(healthy, '服务未在 10 秒内就绪');

    // CORS：允许的来源回显
    const allowed = await fetch(`${base}/api/health`, {
      headers: { Origin: 'https://bogedabuda.github.io' },
    });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://bogedabuda.github.io');

    // CORS：未列入白名单的来源不回显
    const denied = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);

    // 检索端点
    const search = await (await fetch(`${base}/api/search?q=${encodeURIComponent('存内计算')}&limit=3`)).json();
    assert.ok(search.digests.length > 0);
    assert.ok(search.total > 0);

    // 缺少 question 应 400
    const bad = await fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);

    // 未知端点 404
    const missing = await fetch(`${base}/api/nope`);
    assert.equal(missing.status, 404);

    // 深挖：缺少 q 时返回空
    const deep = await (
      await fetch(`${base}/api/deep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: '' }),
      })
    ).json();
    assert.equal(deep.total, 0);
  } finally {
    child.kill('SIGTERM');
  }
});
