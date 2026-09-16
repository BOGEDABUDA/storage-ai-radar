/** 单期报告页：按分类展示该期的双视角要点。 */

import { h } from '../lib/dom';
import { categoryColor, loadDigests } from '../lib/data';
import { cnDate } from '../lib/format';
import { renderDigest } from '../components/digest';
import type { Manifest } from '../lib/types';

export async function renderReport(manifest: Manifest, date: string): Promise<HTMLElement> {
  const index = manifest.dates.indexOf(date);
  if (index < 0) {
    return h(
      'div',
      { class: 'container' },
      h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, '未找到该期报告')),
      h(
        'p',
        { class: 'muted' },
        '日期 ',
        h('code', {}, date),
        ' 不在语料范围内。',
        h('a', { href: '#/archive' }, '返回归档'),
      ),
    );
  }

  const digests = await loadDigests();
  const own = digests.filter((d) => d.date === date);

  const prev = manifest.dates[index - 1];
  const next = manifest.dates[index + 1];

  const toc = h('nav', { class: 'toc', 'aria-label': '本期分类' });
  for (const meta of manifest.categories) {
    if (!own.some((d) => d.category === meta.key)) continue;
    toc.appendChild(
      h(
        'a',
        { href: `#cat-${meta.key}`, style: { color: categoryColor(meta.key) } },
        meta.name,
      ),
    );
  }

  const sections: HTMLElement[] = [];
  for (const meta of manifest.categories) {
    const items = own.filter((d) => d.category === meta.key);
    if (items.length === 0) continue;
    sections.push(
      h(
        'section',
        { class: 'section', id: `cat-${meta.key}` },
        h(
          'h2',
          { class: 'section-title', style: { color: categoryColor(meta.key) } },
          h('a', { href: `#/domain/${encodeURIComponent(meta.key)}`, style: { color: 'inherit' } }, meta.name),
          h('span', { class: 'section-title__note' }, `${items.length} 条`),
        ),
        h('div', { class: 'digest-list' }, ...items.map((d) => renderDigest(d, { showDate: false }))),
      ),
    );
  }

  return h(
    'div',
    { class: 'container' },
    h(
      'div',
      { class: 'page-head' },
      h('span', { class: 'eyebrow' }, '每日信息简报'),
      h('h1', { class: 'page-title' }, cnDate(date)),
      h(
        'p',
        { class: 'page-lede' },
        `本期共 ${own.length} 条精选洞察，覆盖 ${sections.length} 个研究方向。`,
      ),
      h(
        'div',
        { class: 'filters', style: { marginTop: 'var(--space-3)', marginBottom: 0 } },
        prev ? h('a', { class: 'filter-pill', href: `#/report/${prev}` }, `← ${prev}`) : null,
        h('a', { class: 'filter-pill', href: '#/archive' }, '全部归档'),
        next ? h('a', { class: 'filter-pill', href: `#/report/${next}` }, `${next} →`) : null,
      ),
    ),
    toc,
    ...sections,
  );
}
