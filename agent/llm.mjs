/** DeepSeek 流式客户端 + API key 解析（key 只本机保存，绝不进仓库）。 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const API_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
export const DEFAULT_MODEL = process.env.RADAR_AGENT_MODEL || 'deepseek-v4-flash';
const MAX_TOKENS = 32768; // 该模型为推理模型，推理 token 计入配额，不可设小

/** 极简 .env 解析（只支持 KEY=VALUE）。 */
export function loadEnvFile(envPath) {
  if (!existsSync(envPath)) return {};
  const out = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * 取 API key：环境变量 > agent/.env > 日报工作流脚本（只读复用，不复制到本项目）。
 */
export function resolveApiKey(projectRoot) {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();

  const env = loadEnvFile(path.join(projectRoot, 'agent', '.env'));
  if (env.DEEPSEEK_API_KEY) return env.DEEPSEEK_API_KEY.trim();

  const script = '/Users/boding/.openclaw/workspace/Daily Report/summarize_articles.py';
  if (existsSync(script)) {
    const match = readFileSync(script, 'utf8').match(/API_KEY\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  }
  return null;
}

/**
 * 流式对话。产出 {type:'delta', text} 或 {type:'reasoning', text}。
 * 推理内容是模型内部思考，默认不作为答案输出。
 */
export async function* streamChat({ apiKey, model = DEFAULT_MODEL, messages, signal, temperature = 0.2 }) {
  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: true, temperature, max_tokens: MAX_TOKENS }),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`DeepSeek API ${response.status}: ${detail.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content };
      if (delta.content) yield { type: 'delta', text: delta.content };
    }
  }
}
