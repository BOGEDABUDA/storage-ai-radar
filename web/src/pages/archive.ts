/** 归档页：42 期报告入口。 */

import { h } from '../lib/dom';
import { loadTimeline } from '../lib/data';
import { cnDate, n } from '../lib/format';
import type { Manifest } from '../lib/types';

export async function renderArchive(manifest: Manifest): Promise<HTMLElement> {
  const timeline = await loadTimeline();

  const totals = timeline.dates.map((_, index) =>
    timeline.series.reduce((sum, series) => sum + (series.article_counts[index] ?? 0), 0),
  );
  const digestTotals = timeline.dates.map((_, index) =>
    timeline.series.reduce((sum, series) => sum + (series.digest_counts[index] ?? 0), 0),
  );

  const items = manifest.dates
    .map((date, index) => ({ date, articles: totals[index] ?? 0, digests: digestTotals[index] ?? 0 }))
    .reverse();

  return h(
    'div',
    { class: 'container' },
    h(
      'div',
      { class: 'page-head' },
      h('span', { class: 'eyebrow' }, '报告归档'),
      h('h1', { class: 'page-title' }, `${manifest.report_count} 期每日信息简报`),
      h('p', { class: 'page-lede' }, '每期包含 10 个研究方向的「商业视角」与「学术/技术视角」双要点，可逐期浏览或分享链接。'),
    ),
    h(
      'div',
      { class: 'archive-grid' },
      ...items.map((item) =>
        h(
          'a',
          { class: 'archive-item', href: `#/report/${item.date}` },
          h('span', { class: 'archive-item__date' }, item.date),
          h(
            'span',
            { class: 'archive-item__meta' },
            `${n(item.articles)} 篇 · ${item.digests} 条洞察`,
            h('br'),
            cnDate(item.date),
          ),
        ),
      ),
    ),
  );
}
