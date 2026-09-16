/** 概览页：语料统计、领域卡片、语料节奏、最新一期亮点。 */

import { h } from '../lib/dom';
import { loadDigests, loadTimeline } from '../lib/data';
import { barChart, mountResponsive } from '../lib/charts';
import { cnDate, compact, n, shortDate } from '../lib/format';
import { renderDigest, renderDomainCard } from '../components/digest';
import type { Manifest } from '../lib/types';

function statRow(manifest: Manifest): HTMLElement {
  const first = manifest.dates[0] ?? '';
  const last = manifest.dates[manifest.dates.length - 1] ?? '';
  const items: [string, string][] = [
    [n(manifest.report_count), '期简报'],
    [compact(manifest.article_count), '篇文章摘要'],
    [n(manifest.digest_count), '条精选洞察'],
    [`${shortDate(first)}–${shortDate(last)}`, '时间跨度'],
  ];
  return h(
    'div',
    { class: 'stat-row' },
    ...items.map(([value, label]) =>
      h(
        'div',
        { class: 'stat' },
        h('span', { class: 'stat__value' }, value),
        h('span', { class: 'stat__label' }, label),
      ),
    ),
  );
}

export async function renderOverview(manifest: Manifest): Promise<HTMLElement> {
  const [timeline, digests] = await Promise.all([loadTimeline(), loadDigests()]);

  const latestDate = manifest.dates[manifest.dates.length - 1] ?? '';
  const latestDigests = digests.filter((d) => d.date === latestDate);

  // 领域卡片：用每期文章量画迷你趋势（比洞察数更能反映实际关注度变化）
  const cards = manifest.categories.map((meta) => {
    const series = timeline.series.find((s) => s.category === meta.key);
    return renderDomainCard(meta, series?.article_counts ?? [], meta.last_seen);
  });

  // 语料节奏：每期文章数（可看出 2026-05-15 等稀疏期）
  const totals = timeline.dates.map((_, index) =>
    timeline.series.reduce((sum, series) => sum + (series.article_counts[index] ?? 0), 0),
  );
  const rhythm = h('div', { class: 'chart-host' });
  mountResponsive(rhythm, (width) => barChart(timeline.dates.map(shortDate), totals, { width, height: 210 }), 210);

  return h(
    'div',
    { class: 'container' },
    h(
      'div',
      { class: 'page-head' },
      h('span', { class: 'eyebrow' }, 'Lab Insight Radar'),
      h('h1', { class: 'page-title' }, '存储与 AI 基础设施 · 领域洞察雷达'),
      h(
        'p',
        { class: 'page-lede' },
        `汇总 ${manifest.report_count} 期每日信息简报（${manifest.dates[0]} 至 ${manifest.dates[manifest.dates.length - 1]}），`,
        `覆盖 ${n(manifest.article_count)} 篇文章摘要与 ${manifest.digest_count} 条精选洞察，按 10 个研究方向分类。`,
      ),
    ),

    statRow(manifest),

    h(
      'div',
      { class: 'notice' },
      h('strong', {}, '数据说明：'),
      `「其他」分类占全部文章的 42%（异质汇总），不参与领域热度排名；`,
      `${manifest.empty_summaries} 篇文章的原文摘要在源数据中即为空。`,
    ),

    h(
      'section',
      { class: 'section' },
      h(
        'h2',
        { class: 'section-title' },
        '研究领域',
        h('span', { class: 'section-title__note' }, '点击进入该领域的进展跟踪'),
      ),
      h('div', { class: 'card-grid' }, ...cards),
    ),

    h(
      'section',
      { class: 'section' },
      h(
        'h2',
        { class: 'section-title' },
        '语料节奏',
        h('span', { class: 'section-title__note' }, '每期文章数；明显低谷为当日抓取/总结不完整的真实缺口'),
      ),
      rhythm,
    ),

    h(
      'section',
      { class: 'section' },
      h(
        'h2',
        { class: 'section-title' },
        `最新一期 · ${cnDate(latestDate)}`,
        h('span', { class: 'section-title__note' }, `${latestDigests.length} 条精选洞察`),
      ),
      h('div', { class: 'digest-list' }, ...latestDigests.map((d) => renderDigest(d, { showCategoryLink: true }))),
    ),
  );
}
