/** 领域页：单研究方向的文章趋势、洞察时间线。 */

import { h } from '../lib/dom';
import { categoryColor, loadDigests, loadTimeline } from '../lib/data';
import { lineChart, mountResponsive } from '../lib/charts';
import { cnDate, n, shortDate } from '../lib/format';
import { renderDigest } from '../components/digest';
import { openAgent } from '../lib/agentBus';
import type { Manifest, TimelineSeries } from '../lib/types';

function sidePanel(manifest: Manifest, active: string, timeline: { series: TimelineSeries[] }): HTMLElement {
  const list = h('ul', { class: 'side-list' });
  const items = manifest.categories
    .filter((meta) => meta.key !== active)
    .map((meta) => ({ meta, count: meta.article_count }))
    .sort((a, b) => b.count - a.count);

  for (const { meta, count } of items) {
    list.appendChild(
      h(
        'li',
        {},
        h(
          'a',
          { href: `#/domain/${encodeURIComponent(meta.key)}` },
          h('span', { style: { color: categoryColor(meta.key) } }, meta.name),
          h('span', { class: 'num' }, n(count)),
        ),
      ),
    );
  }

  const total = timeline.series.find((s) => s.category === active);
  const panel = h(
    'aside',
    { class: 'side-panel' },
    h('h3', {}, '同期洞察'),
    h(
      'p',
      { class: 'muted', style: { fontSize: 'var(--fs-xs)', margin: 0 } },
      total
        ? `本领域共 ${total.digest_counts.reduce((a, b) => a + b, 0)} 条洞察，覆盖 ${total.article_counts.filter((c) => c > 0).length} 期。`
        : '',
    ),
    h('hr', {}),
    h('h3', {}, '切换到其他领域'),
    list,
  );
  return panel;
}

export async function renderDomain(manifest: Manifest, slug: string): Promise<HTMLElement> {
  const meta = manifest.categories.find((c) => c.key === slug);
  if (!meta) {
    return h(
      'div',
      { class: 'container' },
      h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, '未知领域')),
      h('p', { class: 'muted' }, '未找到该领域：', h('code', {}, slug), '。', h('a', { href: '#/' }, '返回概览')),
    );
  }

  const [timeline, digests] = await Promise.all([loadTimeline(), loadDigests()]);
  const series = timeline.series.find((s) => s.category === slug);
  const color = categoryColor(slug);
  const own = digests.filter((d) => d.category === slug).slice().reverse(); // 最新在前

  const chartHost = h('div', { class: 'chart-host' });
  mountResponsive(
    chartHost,
    (width) =>
      lineChart(timeline.dates.map(shortDate), series?.article_counts ?? [], {
        width,
        height: 240,
        color,
        annotateMax: true,
      }),
    240,
  );

  const business = own.filter((d) => d.perspective === 'business').length;
  const technical = own.filter((d) => d.perspective === 'technical').length;
  const topic = own.filter((d) => d.perspective === 'topic').length;

  const head = h(
    'div',
    { class: 'page-head' },
    h('span', { class: 'eyebrow' }, '研究领域'),
    h('h1', { class: 'page-title', style: { color } }, meta.name),
    h(
      'p',
      { class: 'page-lede' },
      `共 ${n(meta.article_count)} 篇文章摘要、${meta.digest_count} 条精选洞察`,
      meta.first_seen ? `，最早见于 ${cnDate(meta.first_seen)}，最近见于 ${cnDate(meta.last_seen ?? '')}。` : '。',
    ),
    h(
      'div',
      { class: 'filters', style: { marginTop: 'var(--space-3)', marginBottom: 0 } },
      h('span', { class: 'chip chip--business' }, `商业视角 ${business}`),
      h('span', { class: 'chip chip--technical' }, `学术/技术视角 ${technical}`),
      topic > 0 ? h('span', { class: 'chip chip--topic' }, `主题 ${topic}`) : null,
      meta.is_catch_all
        ? h('span', { class: 'chip chip--catch-all' }, '异质汇总分类，不参与热度排名')
        : null,
      h(
        'button',
        {
          class: 'filter-pill agent-deep',
          type: 'button',
          onclick: () => openAgent(`「${meta.name}」这个方向近期有哪些关键进展？请给出量化数据与时间线。`),
        },
        '✦ 用 Agent 追踪这一领域',
      ),
    ),
  );

  const main = h(
    'div',
    {},
    h(
      'section',
      { class: 'section' },
      h(
        'h2',
        { class: 'section-title' },
        '文章量趋势',
        h('span', { class: 'section-title__note' }, '每期进入该领域的文章数（含原文摘要）'),
      ),
      chartHost,
    ),
    h(
      'section',
      { class: 'section' },
      h(
        'h2',
        { class: 'section-title' },
        '精选洞察时间线',
        h('span', { class: 'section-title__note' }, `共 ${own.length} 条，最新在前`),
      ),
      own.length > 0
        ? h('div', { class: 'digest-list' }, ...own.map((d) => renderDigest(d)))
        : h('div', { class: 'empty' }, '该领域暂无精选洞察'),
    ),
  );

  return h(
    'div',
    { class: 'container' },
    head,
    h('div', { class: 'split' }, main, sidePanel(manifest, slug, timeline)),
  );
}
