#!/usr/bin/env node
/**
 * Lab Insight Radar · 本机 Agent 服务
 *
 * 零 npm 依赖：node:http + node:sqlite + fetch。
 * 默认只绑 127.0.0.1，API key 只从本机读取，永不下发到前端。
 *
 * 端点：
 *   GET  /api/health                 健康检查（前端据此决定是否启用问答）
 *   GET  /api/search?q=&category=&from=&to=&limit=
 *   GET  /api/entity/:label          某实体/关键词的深挖资料
 *   POST /api/deep                   在原始正文里检索（默认只扫最近若干期）
 *   POST /api/ask                    基于检索结果流式问答（SSE，带引用）
 *
 * 启动：node agent/server.mjs   （或 npm run agent）
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SYSTEM_PROMPT,
  buildContext,
  deepSearch,
  entityContext,
  indexStats,
  openIndex,
  parseTerms,
  searchArticles,
  searchDigests,
  searchWithFallback,
} from './rag.mjs';
import { DEFAULT_MODEL, loadEnvFile, resolveApiKey, streamChat } from './llm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

const envFile = loadEnvFile(path.join(HERE, '.env'));
const PORT = Number(process.env.RADAR_AGENT_PORT || envFile.RADAR_AGENT_PORT || 8787);
const HOST = process.env.RADAR_AGENT_HOST || envFile.RADAR_AGENT_HOST || '127.0.0.1';
const MODEL = envFile.RADAR_AGENT_MODEL || DEFAULT_MODEL;
const DB_PATH = envFile.RADAR_INDEX_PATH || path.join(PROJECT_ROOT, 'insight.sqlite');
const SOURCE_DIR =
  envFile.DAILY_REPORT_DIR || process.env.DAILY_REPORT_DIR || '/Users/boding/.openclaw/workspace/Daily Report';
const AUTH_TOKEN = envFile.RADAR_AGENT_TOKEN || process.env.RADAR_AGENT_TOKEN || null;

// 允许站点从 github.io 与本地来源调用（http://localhost 属安全上下文，不被混合内容拦截）
const DEFAULT_ORIGINS = [
  'https://bogedabuda.github.io',
  'http://localhost:4173',
  'http://localhost:5173',
  'http://127.0.0.1:4173',
  'http://127.0.0.1:5173',
];
const ALLOWED_ORIGINS = (envFile.RADAR_ALLOWED_ORIGINS || process.env.RADAR_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ORIGINS = ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : DEFAULT_ORIGINS;

if (!process.env.DEEPSEEK_API_KEY && envFile.DEEPSEEK_API_KEY) {
  process.env.DEEPSEEK_API_KEY = envFile.DEEPSEEK_API_KEY;
}
const API_KEY = resolveApiKey(PROJECT_ROOT);

let db;
try {
  db = openIndex(DB_PATH);
} catch (error) {
  console.error(`[错误] 无法打开索引 ${DB_PATH}`);
  console.error('       请先运行： python3 -m pipeline.build_index');
  console.error(`       ${error.message}`);
  process.exit(1);
}

const stats = indexStats(db);
console.log(`[索引] 洞察 ${stats.digests} · 文章 ${stats.articles}（构建于 ${stats.generated_at}）`);
console.log(`[语料] 原始正文目录 ${SOURCE_DIR}`);
console.log(`[模型] ${MODEL}${API_KEY ? '' : '  ⚠️ 未找到 DEEPSEEK_API_KEY，问答将不可用（检索仍可用）'}`);

function corsHeaders(origin) {
  const allowed = origin && ORIGINS.includes(origin) ? origin : null;
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    // 浏览器的本地网络访问策略（Local/Private Network Access）要求：
    // 公网站点（如 github.io）请求 loopback 地址时，服务端必须显式允许，
    // 否则会被 CORS 拦截为 "Permission was denied ... loopback address space"
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowed) headers['Access-Control-Allow-Origin'] = allowed;
  return headers;
}

function sendJson(res, status, payload, origin) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(origin),
  });
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function authorised(req) {
  if (!AUTH_TOKEN) return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${AUTH_TOKEN}`;
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  try {
    if (url.pathname === '/api/health') {
      sendJson(
        res,
        200,
        {
          ok: true,
          service: 'lab-insight-radar-agent',
          model: MODEL,
          llm_ready: Boolean(API_KEY),
          index: stats,
          source_dir: SOURCE_DIR,
        },
        origin,
      );
      return;
    }

    if (!authorised(req)) {
      sendJson(res, 401, { error: '未授权' }, origin);
      return;
    }

    if (url.pathname === '/api/search' && req.method === 'GET') {
      const query = {
        q: url.searchParams.get('q') ?? '',
        category: url.searchParams.get('category') || undefined,
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        limit: Math.min(Number(url.searchParams.get('limit') || 30), 100),
      };
      const { digests, articles, relaxed } = searchWithFallback(db, {
        ...query,
        digestLimit: 10,
        articleLimit: query.limit,
      });
      sendJson(res, 200, { digests, articles, relaxed, total: digests.length + articles.length }, origin);
      return;
    }

    if (url.pathname.startsWith('/api/entity/') && req.method === 'GET') {
      const label = decodeURIComponent(url.pathname.slice('/api/entity/'.length));
      if (!label) {
        sendJson(res, 400, { error: '缺少实体名' }, origin);
        return;
      }
      const { digests, articles } = entityContext(db, label, { limit: 12 });
      const { context, blocks } = buildContext(digests, articles);
      sendJson(res, 200, { label, sources: blocks, context_bytes: context.length }, origin);
      return;
    }

    if (url.pathname === '/api/deep' && req.method === 'POST') {
      const body = await readBody(req);
      const hits = await deepSearch(SOURCE_DIR, {
        q: body.q ?? '',
        date: body.date,
        dates: Math.min(Number(body.dates || 6), 42),
        limit: Math.min(Number(body.limit || 8), 30),
      });
      sendJson(res, 200, { hits, total: hits.length }, origin);
      return;
    }

    if (url.pathname === '/api/ask' && req.method === 'POST') {
      const body = await readBody(req);
      const question = String(body.question ?? '').trim();
      if (!question) {
        sendJson(res, 400, { error: '缺少 question' }, origin);
        return;
      }
      if (!API_KEY) {
        sendJson(res, 503, { error: '服务端未配置 DEEPSEEK_API_KEY，问答不可用' }, origin);
        return;
      }

      const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
      const category = body.category || undefined;
      const { digests, articles, relaxed } = searchWithFallback(db, {
        q: question,
        category,
        digestLimit: 12,
        articleLimit: 24,
      });
      const { context, blocks } = buildContext(digests, articles);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...corsHeaders(origin),
      });

      const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      send('sources', { sources: blocks, relaxed });

      if (blocks.length === 0) {
        send('delta', { text: '现有资料里没有检索到与此问题相关的内容。可以换个说法，或先在「检索」页确认语料里是否有该主题。' });
        send('done', { cited: [], latency_ms: 0 });
        res.end();
        return;
      }

      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') })),
        { role: 'user', content: `【资料】\n${context}\n\n【问题】\n${question}` },
      ];

      const controller = new AbortController();
      req.on('close', () => controller.abort());
      const startedAt = Date.now();
      let answer = '';

      try {
        for await (const chunk of streamChat({ apiKey: API_KEY, model: MODEL, messages, signal: controller.signal })) {
          if (chunk.type === 'reasoning') {
            send('reasoning', { text: chunk.text });
          } else {
            answer += chunk.text;
            send('delta', { text: chunk.text });
          }
        }
        const cited = [...new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))]
          .filter((n) => n >= 1 && n <= blocks.length)
          .sort((a, b) => a - b);
        send('done', { cited, latency_ms: Date.now() - startedAt });
      } catch (error) {
        if (!controller.signal.aborted) {
          send('error', { message: String(error.message ?? error) });
        }
      } finally {
        res.end();
      }
      return;
    }

    sendJson(res, 404, { error: '未知端点' }, origin);
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: String(error.message ?? error) }, origin);
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Lab Insight Radar Agent 已启动`);
  console.log(`  → http://${HOST}:${PORT}/api/health`);
  console.log(`  允许的来源：${ORIGINS.join(', ')}`);
  console.log(`  ${AUTH_TOKEN ? '已启用 Bearer Token 鉴权' : '未启用鉴权（仅监听本机）'}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n[关闭] Agent 服务退出');
    try {
      db.close();
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0));
  });
}
