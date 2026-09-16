/** 趋势跟踪页：领域动量、上升/新兴/退潮实体、信号分野、量化指标。 */

import { h } from '../lib/dom';
import { categoryColor, loadTimeline, loadTrends } from '../lib/data';
import { lineChart, mountResponsive, sparseLineChart, sparkline } from '../lib/charts';
import { n } from '../lib/format';
import type { Manifest, TrendEntity, TrendsFile } from '../lib/types';

const DIRECTION_MARK: Record<string, string> = { up: '▲', flat: '▬', down: '▼' };
const DIRECTION_LABEL: Record<string, string> = { up: '升温', flat: '持平', down: '降温' };

function directionColor(direction: string): string {
  if (direction === 'up') return 'var(--sage)';
  if (direction === 'down') return 'var(--clay)';
  return 'var(--ink-faint)';
}

function entityRow(entity: TrendEntity, manifest: Manifest, mode: 'rising' | 'new' | 'fading'): HTMLElement {
  const name = manifest.categories.find((c) => c.key === entity.category)?.name ?? entity.category;
  const metric =
    mode === 'new'
      ? `首次 ${entity.first_seen}`
      : mode === 'fading'
        ? `基线 ${entity.baseline} 次 → 近 3 期 0 次`
        : `近 3 期 ${entity.recent} 次 vs 基线 ${entity.baseline}`;

  return h(
    'a',
    { class: 'trend-row', href: `#/domain/${encodeURIComponent(entity.category)}` },
    h('span', { class: 'trend-row__label', style: { color: categoryColor(entity.category) } }, entity.label),
    h('span', { class: 'trend-row__meta' }, `${name} · 共 ${entity.mentions} 次`),
    h('span', { class: 'trend-row__metric num' }, metric),
  );
}

function momentumBoard(trends: TrendsFile): HTMLElement {
  const rows = [...trends.categories].sort((a, b) => b.momentum - a.momentum);
  const head = h(
    'tr',
    {},
    h('th', {}, '研究领域'),
    h('th', { class: 'num' }, '动量'),
    h('th', {}, '方向'),
    h('th', { class: 'num' }, '近 3 期'),
    h('th', { class: 'num' }, '基线'),
    h('th', {}, '逐期文章量'),
    h('th', { class: 'num' }, '商业/学术'),
    h('th', { class: 'num' }, '入榜'),
  );

  const body = h('tbody', {});
  for (const category of rows) {
    const color = categoryColor(category.category);
    const spark = h('div', { style: { width: '110px', height: '26px' } });
    spark.appendChild(sparkline(category.article_counts, { color, height: 26 }));
    body.appendChild(
      h(
        'tr',
        { class: category.is_catch_all ? 'is-muted' : null },
        h(
          'td',
          {},
          h('a', { href: `#/domain/${encodeURIComponent(category.category)}`, style: { color } }, category.name),
          category.is_catch_all ? h('span', { class: 'chip chip--catch-all', style: { marginLeft: '6px' } }, '异质汇总') : null,
        ),
        h('td', { class: 'num', style: { color: directionColor(category.direction) } }, category.momentum >= 0 ? `+${category.momentum.toFixed(2)}` : category.momentum.toFixed(2)),
        h('td', { style: { color: directionColor(category.direction) } }, `${DIRECTION_MARK[category.direction]} ${DIRECTION_LABEL[category.direction]}`),
        h('td', { class: 'num' }, n(category.recent_articles)),
        h('td', { class: 'num muted' }, category.baseline_articles.toFixed(0)),
        h('td', {}, spark),
        h('td', { class: 'num' }, `${category.business} / ${category.technical}`),
        h('td', { class: 'num' }, category.is_catch_all ? '—' : '✓'),
      ),
    );
  }
  return h('table', { class: 'data-table' }, h('thead', {}, head), body);
}

function perspectiveLean(trends: TrendsFile): HTMLElement {
  const rows = trends.entity_perspective.slice(0, 22);
  const host = h('div', {});

  if (rows.length === 0) {
    return h('div', { class: 'empty' }, '暂无足够的实体视角样本');
  }

  for (const entity of rows) {
    const total = entity.business + entity.technical;
    const businessPct = (entity.business / total) * 100;
    const technicalPct = (entity.technical / total) * 100;
    host.appendChild(
      h(
        'div',
        { class: 'lean-row' },
        h(
          'a',
          {
            class: 'lean-row__name',
            href: `#/domain/${encodeURIComponent(entity.category)}`,
            style: { color: categoryColor(entity.category) },
            title: entity.label,
          },
          entity.label,
        ),
        h(
          'div',
          { class: 'lean-row__track', title: `商业 ${entity.business} · 学术/技术 ${entity.technical}` },
          h(
            'div',
            { class: 'lean-row__half lean-row__half--left' },
            h('div', { class: 'lean-row__bar lean-row__bar--technical', style: { width: `${technicalPct}%` } }),
          ),
          h('div', { class: 'lean-row__axis' }),
          h(
            'div',
            { class: 'lean-row__half lean-row__half--right' },
            h('div', { class: 'lean-row__bar lean-row__bar--business', style: { width: `${businessPct}%` } }),
          ),
        ),
        h('span', { class: 'lean-row__value num' }, `${entity.business} / ${entity.technical}`),
      ),
    );
  }

  host.appendChild(
    h(
      'div',
      { class: 'muted', style: { fontSize: 'var(--fs-xs)', marginTop: 'var(--space-3)' } },
      '中轴左侧为学术/技术视角、右侧为商业视角。数值是「商业 / 学术」提及次数，按偏离均衡的程度排序。',
      h('br'),
      '实体主要出现在商业视角，说明该方向正被资本与产业推动；只在学术视角出现，说明技术本身仍在演进、尚未产品化。',
    ),
  );
  return host;
}

function metricCard(
  subject: string,
  label: string,
  unit: string | null,
  points: { date: string; value: number }[],
  dates: string[],
  color: string,
): HTMLElement {
  const host = h('div', { style: { minHeight: '180px' } });
  mountResponsive(host, (width) => sparseLineChart(dates, points, { width, height: 180, color, unit }), 180);

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const delta = first.value === 0 ? null : (last.value - first.value) / Math.abs(first.value);

  return h(
    'div',
    { class: 'metric-card' },
    h('div', { class: 'metric-card__head' },
      h('span', { class: 'metric-card__subject' }, subject),
      h('span', { class: 'metric-card__label' }, label),
    ),
    host,
    h(
      'div',
      { class: 'metric-card__foot' },
      h('span', { class: 'num' }, `${points.length} 个观测点`),
      delta === null ? null : h('span', { class: 'num', style: { color: delta >= 0 ? 'var(--sage)' : 'var(--clay)' } }, `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(0)}%`),
    ),
  );
}

export async function renderTrends(manifest: Manifest): Promise<HTMLElement> {
  const [trends, timeline] = await Promise.all([loadTrends(), loadTimeline()]);
  const dates = timeline.dates;

  const rising = trends.rising_entities;
  const emerging = trends.new_entities;
  const fading = trends.fading_entities;

  const entityPanels = h(
    'div',
    { class: 'trend-columns' },
    h(
      'section',
      { class: 'trend-panel' },
      h('h3', { class: 'trend-panel__title', style: { color: 'var(--sage)' } }, `▲ 上升实体（${rising.length}）`),
      h('p', { class: 'trend-panel__note' }, `近 ${trends.window.recent} 期提及量明显高于前 ${trends.window.baseline} 期基线`),
      rising.length > 0
        ? h('div', {}, ...rising.slice(0, 15).map((entity) => entityRow(entity, manifest, 'rising')))
        : h('div', { class: 'empty' }, '本窗口无上升实体'),
    ),
    h(
      'section',
      { class: 'trend-panel' },
      h('h3', { class: 'trend-panel__title', style: { color: 'var(--accent)' } }, `✦ 新兴实体（${emerging.length}）`),
      h('p', { class: 'trend-panel__note' }, `首次出现落在最近 ${trends.window.recent} 期，可能是值得关注的新方向`),
      emerging.length > 0
        ? h('div', {}, ...emerging.slice(0, 15).map((entity) => entityRow(entity, manifest, 'new')))
        : h('div', { class: 'empty' }, '本窗口无新兴实体'),
    ),
    h(
      'section',
      { class: 'trend-panel' },
      h('h3', { class: 'trend-panel__title', style: { color: 'var(--clay)' } }, `▼ 退潮实体（${fading.length}）`),
      h('p', { class: 'trend-panel__note' }, `基线期活跃但最近 ${trends.window.recent} 期完全未出现`),
      fading.length > 0
        ? h('div', {}, ...fading.slice(0, 15).map((entity) => entityRow(entity, manifest, 'fading')))
        : h('div', { class: 'empty' }, '本窗口无退潮实体'),
    ),
  );

  const metricCards = trends.metrics.map((metric) =>
    metricCard(metric.subject, metric.label, metric.unit, metric.points, dates, categoryColor('ai-inference-acceleration')),
  );

  const observationGroups = trends.metric_observations.slice(0, 24).map((group) =>
    h(
      'details',
      { class: 'obs-group' },
      h(
        'summary',
        {},
        h('span', { class: 'obs-group__label' }, group.label),
        h('span', { class: 'obs-group__meta num' }, `${group.count} 次观测 · ${group.subjects} 个主体`),
      ),
      h(
        'table',
        { class: 'data-table' },
        h('thead', {}, h('tr', {}, h('th', {}, '日期'), h('th', {}, '主体'), h('th', { class: 'num' }, '数值'))),
        h(
          'tbody',
          {},
          ...group.observations
            .slice()
            .reverse()
            .map((observation) =>
              h(
                'tr',
                {},
                h('td', { class: 'num' }, observation.date),
                h('td', {}, observation.subject),
                h('td', { class: 'num' }, `${observation.value} ${observation.unit ?? ''}`),
              ),
            ),
        ),
      ),
    ),
  );

  // 领域层面的商业/学术信号对比图（商业 + 学术堆叠）
  const signalChart = h('div', { class: 'chart-host' });
  const ranked = trends.categories.filter((c) => !c.is_catch_all);
  mountResponsive(
    signalChart,
    (width) =>
      lineChart(
        dates.map((d) => d.slice(5)),
        ranked.reduce((acc, c) => acc.map((v, i) => v + (c.digest_counts[i] ?? 0)), new Array(dates.length).fill(0)),
        { width, height: 200, color: 'var(--accent)' },
      ),
    200,
  );

  return h(
    'div',
    { class: 'container' },
    h(
      'div',
      { class: 'page-head' },
      h('span', { class: 'eyebrow' }, '趋势跟踪'),
      h('h1', { class: 'page-title' }, '领域进展与信号分野'),
      h(
        'p',
        { class: 'page-lede' },
        `基于 ${manifest.report_count} 期语料计算。动量 =（近 ${trends.window.recent} 期均值 − 前 ${trends.window.baseline} 期基线）/ 基线，`,
        `> +0.3 记为升温，< −0.3 记为降温。「其他」为异质汇总，不参与排名。`,
      ),
    ),

    h(
      'section',
      { class: 'section' },
      h('h2', { class: 'section-title' }, '领域动量看板', h('span', { class: 'section-title__note' }, '按动量降序')),
      momentumBoard(trends),
    ),

    h(
      'section',
      { class: 'section' },
      h('h2', { class: 'section-title' }, '实体级信号', h('span', { class: 'section-title__note' }, '来自 794 条洞察的实体抽取结果')),
      entityPanels,
    ),

    h(
      'section',
      { class: 'section' },
      h(
        'h2',
        { class: 'section-title' },
        '视角倾向：谁在被产业推动，谁还在实验室',
        h('span', { class: 'section-title__note' }, '按实体统计其出现在商业 / 学术视角的次数'),
      ),
      perspectiveLean(trends),
    ),

    h(
      'section',
      { class: 'section' },
      h('h2', { class: 'section-title' }, '全领域洞察总量', h('span', { class: 'section-title__note' }, '不含「其他」')),
      signalChart,
    ),

    h(
      'section',
      { class: 'section' },
      h(
        'h2',
        { class: 'section-title' },
        '关键量化指标',
        h('span', { class: 'section-title__note' }, `同一主体 + 同一指标至少 ${3} 个观测点；虚线表示采样稀疏，不代表连续走势`),
      ),
      metricCards.length > 0
        ? h('div', { class: 'metric-grid' }, ...metricCards)
        : h('div', { class: 'empty' }, '暂无足够密度的指标序列'),
    ),

    h(
      'section',
      { class: 'section' },
      h(
        'h2',
        { class: 'section-title' },
        '指标观测清单',
        h('span', { class: 'section-title__note' }, '按指标名归集全部观测（含主体），用于查证具体数值'),
      ),
      observationGroups.length > 0 ? h('div', { class: 'obs-list' }, ...observationGroups) : h('div', { class: 'empty' }, '暂无观测记录'),
    ),
  );
}
