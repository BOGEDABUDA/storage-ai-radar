/**
 * Agent 侧栏：本机 Agent 的流式问答面板。
 *
 * 关键行为：
 * - 探测不到本机 Agent 时**优雅降级**：显示启动指引，不影响站点其它功能
 * - SSE 流式渲染（EventSource 不支持 POST，因此用 fetch + ReadableStream 手工解析）
 * - 回答按 Markdown 渲染；[n] 引用可点击，跳到对应来源
 */

import { h, clear } from '../lib/dom';
import { renderMarkdown } from '../lib/markdown';
import { n } from '../lib/format';

const DEFAULT_URL = 'http://127.0.0.1:8787';
const URL_KEY = 'radar-agent-url';
const PROBE_TIMEOUT = 2500;

interface Source {
  kind: 'digest' | 'article';
  id: string;
  date: string;
  title: string;
  category: string;
  text: string;
}

interface Health {
  ok: boolean;
  model: string;
  llm_ready: boolean;
  index: { generated_at: string | null; digests: number; articles: number };
}

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  sources?: Source[];
  cited?: number[];
  error?: string;
}

export function agentBaseUrl(): string {
  try {
    return localStorage.getItem(URL_KEY) || DEFAULT_URL;
  } catch {
    return DEFAULT_URL;
  }
}

async function probe(base: string): Promise<Health | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
    const response = await fetch(`${base}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    return (await response.json()) as Health;
  } catch {
    return null;
  }
}

async function streamAsk(
  base: string,
  body: unknown,
  onEvent: (event: string, data: Record<string, unknown>) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`${base}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    let detail = String(response.status);
    try {
      const parsed = await response.json();
      detail = parsed.error ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) {
        try {
          onEvent(event, JSON.parse(data) as Record<string, unknown>);
        } catch {
          /* 忽略坏帧 */
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

const SUGGESTIONS = [
  'KV Cache 压缩近期有哪些关键进展？',
  '近存加速与存内计算这两条路线的差异是什么？',
  'HBM 供需与价格今年怎么走的？',
  '哪些技术已经进入量产、哪些还在论文阶段？',
];

export function createAgentPanel(): { element: HTMLElement; open: (question?: string) => void } {
  const base = agentBaseUrl();
  const turns: Turn[] = [];
  let health: Health | null = null;
  let probing = true;
  let busy = false;
  let controller: AbortController | null = null;
  // 深链接/外部调用可能在健康检查完成前就带着问题进来，先排队再发
  let pendingQuestion: string | null = null;
  let healthPromise: Promise<void> | null = null;

  const statusDot = h('span', { class: 'agent-dot' });
  const statusText = h('span', { class: 'agent-status__text' }, '正在检测本机 Agent…');
  const body = h('div', { class: 'agent-body' });
  const input = h('textarea', {
    class: 'agent-input',
    rows: '2',
    placeholder: '问点什么…（Enter 发送，Shift+Enter 换行）',
    'aria-label': '向 Agent 提问',
  }) as HTMLTextAreaElement;
  const sendButton = h('button', { class: 'agent-send', type: 'button' }, '发送') as HTMLButtonElement;
  const stopButton = h('button', { class: 'agent-stop', type: 'button', hidden: '' }, '停止') as HTMLButtonElement;

  const element = h(
    'aside',
    { class: 'agent-panel', 'aria-hidden': 'true', 'aria-label': 'Agent 问答' },
    h(
      'header',
      { class: 'agent-head' },
      h('div', { class: 'agent-status' }, statusDot, statusText),
      h(
        'button',
        {
          class: 'agent-close',
          type: 'button',
          title: '关闭',
          onclick: () => close(),
        },
        '×',
      ),
    ),
    body,
    h('div', { class: 'agent-compose' }, input, h('div', { class: 'agent-actions' }, stopButton, sendButton)),
  );

  function close(): void {
    element.classList.remove('is-open');
    element.setAttribute('aria-hidden', 'true');
  }

  function open(question?: string): void {
    element.classList.add('is-open');
    element.setAttribute('aria-hidden', 'false');
    if (question) {
      pendingQuestion = question;
      input.value = question;
      void flushPending();
    } else {
      input.focus();
    }
    if (!health) void refreshHealth();
  }

  /** 等健康检查就绪后，把排队的问题发出去。 */
  async function flushPending(): Promise<void> {
    if (!pendingQuestion) return;
    if (!health) {
      await refreshHealth();
    }
    if (!pendingQuestion) return;
    if (!health?.llm_ready || busy) {
      pendingQuestion = null;
      render();
      return;
    }
    const question = pendingQuestion;
    pendingQuestion = null;
    input.value = question;
    await send();
  }

  function setStatus(kind: 'ok' | 'warn' | 'bad' | 'busy', text: string): void {
    statusDot.className = `agent-dot agent-dot--${kind}`;
    statusText.textContent = text;
  }

  function refreshHealth(): Promise<void> {
    // 并发调用共享同一次探测，避免重复请求
    healthPromise ??= (async () => {
      probing = true;
      render();
      health = await probe(base);
      probing = false;
      healthPromise = null;
      render();
    })();
    return healthPromise;
  }

  function offlineView(): HTMLElement {
    return h(
      'div',
      { class: 'agent-offline' },
      h('p', {}, h('strong', {}, '未检测到本机 Agent。')),
      h(
        'p',
        { class: 'muted' },
        '站点本身是纯静态的，图谱、趋势、检索都不依赖 Agent；只有「自由问答」需要它在本机运行。',
      ),
      h('p', {}, '在本机启动：'),
      h('pre', {}, h('code', {}, 'cd storage-ai-radar\npython3 -m pipeline.build_index   # 首次\nnode agent/server.mjs')),
      h(
        'p',
        { class: 'muted' },
        'Agent 只监听 127.0.0.1，API key 仅存本机，不会下发到浏览器。',
      ),
      h('button', { class: 'filter-pill', type: 'button', onclick: () => void refreshHealth() }, '重新检测'),
    );
  }

  function sourceList(turn: Turn): HTMLElement | null {
    if (!turn.sources || turn.sources.length === 0) return null;
    const cited = new Set(turn.cited ?? []);
    const list = h('div', { class: 'agent-sources' });
    turn.sources.forEach((source, index) => {
      const num = index + 1;
      list.appendChild(
        h(
          'a',
          {
            class: cited.size > 0 && !cited.has(num) ? 'agent-source is-uncited' : 'agent-source',
            href: source.kind === 'digest' ? `#/report/${source.date}` : `#/search?q=${encodeURIComponent(source.title.slice(0, 24))}`,
            'data-source': String(num),
            title: source.text.slice(0, 160),
          },
          h('span', { class: 'agent-source__num' }, `[${num}]`),
          h('span', { class: 'agent-source__date' }, source.date),
          h('span', { class: 'agent-source__title' }, source.title),
        ),
      );
    });
    return h(
      'details',
      { class: 'agent-sourcebox' },
      h(
        'summary',
        {},
        `引用来源 ${turn.sources.length} 条`,
        cited.size > 0 ? h('span', { class: 'muted' }, ` · 回答引用了其中 ${cited.size} 条`) : null,
      ),
      list,
    );
  }

  function turnView(turn: Turn): HTMLElement {
    if (turn.role === 'user') {
      return h('div', { class: 'agent-turn agent-turn--user' }, turn.text);
    }
    const content = h('div', { class: 'agent-answer' });
    if (turn.text) {
      content.appendChild(
        renderMarkdown(turn.text, (numIndex) => {
          const target = element.querySelector(`[data-source="${numIndex}"]`);
          target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }),
      );
    } else if (!turn.error) {
      content.appendChild(h('span', { class: 'agent-typing' }, '思考中…'));
    }
    if (turn.error) content.appendChild(h('div', { class: 'notice' }, turn.error));
    const sources = sourceList(turn);
    return h('div', { class: 'agent-turn agent-turn--assistant' }, content, sources ?? null);
  }

  function render(): void {
    clear(body);

    if (probing) {
      body.appendChild(h('div', { class: 'loading' }, '正在检测本机 Agent…'));
      setStatus('busy', '检测中…');
      return;
    }

    if (!health) {
      setStatus('bad', '未连接');
      // 有对话历史时保留历史，只在末尾提示连接已断开，避免把上下文抹掉
      if (turns.length === 0) {
        body.appendChild(offlineView());
      } else {
        for (const turn of turns) body.appendChild(turnView(turn));
        body.appendChild(
          h(
            'div',
            { class: 'notice' },
            '与 Agent 的连接已断开（服务可能已停止）。图谱、趋势、检索等静态功能不受影响。',
            h(
              'button',
              { class: 'filter-pill', type: 'button', style: { marginLeft: '8px' }, onclick: () => void refreshHealth() },
              '重新连接',
            ),
          ),
        );
        body.scrollTop = body.scrollHeight;
      }
      sendButton.disabled = true;
      return;
    }

    setStatus(
      health.llm_ready ? 'ok' : 'warn',
      health.llm_ready
        ? `已连接 · ${health.model} · ${n(health.index.articles)} 篇文章`
        : '已连接，但未配置 API key（仅检索）',
    );
    sendButton.disabled = !health.llm_ready || busy;

    if (turns.length === 0) {
      const intro = h(
        'div',
        { class: 'agent-intro' },
        h('p', {}, '基于全部 42 期语料（15,192 篇文章摘要 + 794 条精选洞察）回答，并给出可点击的来源。'),
        h('p', { class: 'muted' }, '试试这些问题：'),
      );
      for (const suggestion of SUGGESTIONS) {
        intro.appendChild(
          h(
            'button',
            {
              class: 'agent-suggestion',
              type: 'button',
              onclick: () => {
                input.value = suggestion;
                void send();
              },
            },
            suggestion,
          ),
        );
      }
      body.appendChild(intro);
      return;
    }

    for (const turn of turns) body.appendChild(turnView(turn));
    body.scrollTop = body.scrollHeight;
  }

  async function send(): Promise<void> {
    const question = input.value.trim();
    if (!question || busy || !health?.llm_ready) return;

    const history = turns.slice(-4).map((turn) => ({ role: turn.role, content: turn.text }));
    turns.push({ role: 'user', text: question });
    const answer: Turn = { role: 'assistant', text: '' };
    turns.push(answer);
    input.value = '';
    busy = true;
    controller = new AbortController();
    stopButton.hidden = false;
    render();

    try {
      await streamAsk(
        base,
        { question, history },
        (event, data) => {
          if (event === 'sources') {
            answer.sources = (data.sources as Source[]) ?? [];
            render();
          } else if (event === 'delta') {
            answer.text += String(data.text ?? '');
            render();
          } else if (event === 'done') {
            answer.cited = (data.cited as number[]) ?? [];
            render();
          } else if (event === 'error') {
            answer.error = String(data.message ?? '未知错误');
            render();
          }
        },
        controller.signal,
      );
      if (!answer.text && !answer.error) answer.error = 'Agent 没有返回内容，请重试。';
    } catch (error) {
      if (controller.signal.aborted) {
        answer.error = '已停止。';
      } else if (error instanceof TypeError) {
        // fetch 抛 TypeError 通常是网络层失败（服务未启动或已停止）
        answer.error = '无法连接本机 Agent。请确认 agent/server.mjs 正在运行。';
        void refreshHealth();
      } else {
        answer.error = `请求失败：${error instanceof Error ? error.message : String(error)}`;
      }
    } finally {
      busy = false;
      controller = null;
      stopButton.hidden = true;
      render();
    }
  }

  sendButton.addEventListener('click', () => void send());
  stopButton.addEventListener('click', () => controller?.abort());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  });

  void refreshHealth().then(() => flushPending());

  return { element, open };
}
