/** 应用入口：装配外壳、路由分发、错误与加载状态。 */

import './styles/tokens.css';
import './styles/app.css';

import { h, clear } from './lib/dom';
import { loadManifest } from './lib/data';
import { onRouteChange, type Route } from './router';
import { renderHeader, syncHeader } from './components/header';
import { renderOverview } from './pages/overview';
import { renderDomain } from './pages/domain';
import { renderSearch } from './pages/search';
import { renderGraph } from './pages/graph';
import { renderTrends } from './pages/trends';
import { renderArchive } from './pages/archive';
import { renderReport } from './pages/report';
import { watchSystemTheme } from './theme';
import type { Manifest } from './lib/types';

function renderFooter(): HTMLElement {
  const meta = h('span', { class: 'muted' }, '正在读取构建信息…');
  const footer = h(
    'footer',
    { class: 'site-footer' },
    h(
      'div',
      { class: 'container site-footer__inner' },
      h(
        'span',
        {},
        '数据来源：OpenClaw 每日信息简报（微信公众号聚合） · ',
        h('strong', {}, '全程只读，不修改原始语料'),
      ),
      meta,
    ),
  );
  (footer as HTMLElement & { setMeta?: (m: Manifest) => void }).setMeta = (manifest: Manifest) => {
    clear(meta);
    meta.append(
      `构建于 ${manifest.generated_at.slice(0, 16).replace('T', ' ')} · `,
      `${manifest.report_count} 期 · ${manifest.article_count.toLocaleString('zh-CN')} 篇 · `,
      `${manifest.digest_count} 条洞察`,
    );
  };
  return footer;
}

function errorView(error: unknown): HTMLElement {
  const message = error instanceof Error ? error.message : String(error);
  return h(
    'div',
    { class: 'container' },
    h('div', { class: 'notice' }, h('strong', {}, '加载失败：'), message),
    h(
      'p',
      { class: 'muted' },
      '若为首次运行，请确认已执行 ',
      h('code', {}, 'python3 -m pipeline.build'),
      ' 生成 ',
      h('code', {}, 'web/public/data'),
      '。',
    ),
  );
}

function loadingView(): HTMLElement {
  return h('div', { class: 'container' }, h('div', { class: 'loading' }, '正在加载…'));
}

async function renderRoute(route: Route, manifest: Manifest): Promise<HTMLElement> {
  switch (route.name) {
    case 'overview':
      return renderOverview(manifest);
    case 'domain':
      return renderDomain(manifest, route.slug);
    case 'search':
      return renderSearch(manifest, route.q);
    case 'graph':
      return renderGraph(manifest);
    case 'trends':
      return renderTrends(manifest);
    case 'archive':
      return renderArchive(manifest);
    case 'report':
      return renderReport(manifest, route.date);
    default:
      return h(
        'div',
        { class: 'container' },
        h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, '页面不存在')),
        h(
          'p',
          { class: 'muted' },
          '未识别的路径：',
          h('code', {}, route.path || '/'),
          '。',
          h('a', { href: '#/' }, '返回概览'),
        ),
      );
  }
}

async function main(): Promise<void> {
  watchSystemTheme();

  const app = document.getElementById('app');
  if (!app) throw new Error('缺少 #app 容器');

  const header = renderHeader();
  const mainEl = h('main', { id: 'main', class: 'site-main' });
  const footer = renderFooter();
  app.append(header, mainEl, footer);

  let manifest: Manifest | null = null;
  let run = 0;

  async function render(route: Route): Promise<void> {
    const current = ++run;
    syncHeader(header, route);
    clear(mainEl);
    mainEl.appendChild(loadingView());

    try {
      manifest ??= await loadManifest();
      if (current !== run) return;
      (footer as HTMLElement & { setMeta?: (m: Manifest) => void }).setMeta?.(manifest);
      const view = await renderRoute(route, manifest);
      if (current !== run) return;
      clear(mainEl);
      mainEl.appendChild(view);
    } catch (error) {
      if (current !== run) return;
      clear(mainEl);
      mainEl.appendChild(errorView(error));
    }
  }

  onRouteChange((route) => {
    void render(route);
    window.scrollTo({ top: 0, behavior: 'auto' });
  });
}

void main();
