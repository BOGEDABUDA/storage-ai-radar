/** 洞察条目与领域卡片的共享渲染。 */

import { h } from '../lib/dom';
import { categoryColor } from '../lib/data';
import { cnDate, n, perspectiveLabel } from '../lib/format';
import type { CategoryMeta, Digest } from '../lib/types';
import { sparkline } from '../lib/charts';

export function perspectiveChip(perspective: string): HTMLElement {
  return h(
    'span',
    { class: `chip chip--${perspective}` },
    perspectiveLabel(perspective),
  );
}

export interface DigestOptions {
  showDate?: boolean;
  showCategoryLink?: boolean;
}

export function renderDigest(digest: Digest, options: DigestOptions = {}): HTMLElement {
  const head = h('div', { class: 'digest__head' }, perspectiveChip(digest.perspective));

  if (options.showCategoryLink) {
    head.appendChild(
      h(
        'a',
        {
          class: 'chip',
          href: `#/domain/${encodeURIComponent(digest.category)}`,
          style: { color: categoryColor(digest.category) },
        },
        digest.category_name,
      ),
    );
  }

  head.appendChild(h('h3', { class: 'digest__topic' }, digest.topic));
  if (options.showDate !== false) {
    head.appendChild(h('span', { class: 'digest__date' }, cnDate(digest.date)));
  }

  const body: (Node | string)[] = [head, h('p', { class: 'digest__text' }, digest.text)];

  if (digest.sources.length > 0) {
    const sources = h('div', { class: 'digest__sources' }, '来源：');
    digest.sources.forEach((source, index) => {
      if (index > 0) sources.append(' · ');
      sources.appendChild(
        h(
          'a',
          {
            href: source.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            title: source.title,
          },
          source.title.length > 60 ? `${source.title.slice(0, 60)}…` : source.title,
          h('span', { class: 'cite' }, String(index + 1)),
        ),
      );
    });
    body.push(sources);
  }

  return h(
    'article',
    { class: 'digest', style: { '--cat': categoryColor(digest.category) } as unknown as CSSStyleDeclaration },
    ...body,
  );
}

/** 领域卡片：标题 + 计数 + 洞察趋势迷你图。 */
export function renderDomainCard(
  meta: CategoryMeta,
  sparkValues: number[],
  latestDate: string | null,
): HTMLElement {
  const color = categoryColor(meta.key);

  const foot = h(
    'div',
    { class: 'domain-card__foot' },
    h('span', {}, latestDate ? `最近 ${latestDate}` : '无数据'),
    h('span', { class: 'num' }, `${n(meta.digest_count)} 条洞察`),
  );

  return h(
    'a',
    {
      class: 'domain-card',
      href: `#/domain/${encodeURIComponent(meta.key)}`,
      style: { '--cat': color } as unknown as CSSStyleDeclaration,
    },
    h('div', { class: 'domain-card__title' }, meta.name),
    h(
      'div',
      { class: 'domain-card__meta' },
      h('span', { class: 'num' }, n(meta.article_count)),
      '篇文章',
      meta.is_catch_all ? h('span', { class: 'chip chip--catch-all' }, '异质汇总，不计入热度主榜') : null,
    ),
    h('div', { class: 'domain-card__spark' }, sparkline(sparkValues, { color, height: 34 })),
    foot,
  );
}
