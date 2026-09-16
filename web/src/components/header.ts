/** 页头：品牌、导航、主题三态切换。 */

import { h } from '../lib/dom';
import type { Route } from '../router';
import { activeSection } from '../router';
import { MODE_CYCLE, MODE_LABEL, getMode, nextMode, onThemeChange, setMode, type ThemeMode } from '../theme';

interface NavItem {
  label: string;
  hash: string;
  section: string;
}

const NAV: NavItem[] = [
  { label: '概览', hash: '#/', section: 'overview' },
  { label: '领域', hash: '#/domain/ai-inference-acceleration', section: 'domain' },
  { label: '图谱', hash: '#/graph', section: 'graph' },
  { label: '趋势', hash: '#/trends', section: 'trends' },
  { label: '检索', hash: '#/search', section: 'search' },
  { label: '归档', hash: '#/archive', section: 'archive' },
];

function themeToggle(): HTMLElement {
  const buttons = new Map<ThemeMode, HTMLButtonElement>();

  const sync = (): void => {
    const mode = getMode();
    for (const [key, button] of buttons) {
      button.setAttribute('aria-pressed', String(key === mode));
    }
  };

  const group = h('div', {
    class: 'theme-toggle',
    role: 'group',
    'aria-label': '主题模式',
  });

  for (const mode of MODE_CYCLE) {
    const button = h(
      'button',
      {
        type: 'button',
        title: `主题：${MODE_LABEL[mode]}`,
        onclick: () => {
          setMode(mode === getMode() ? nextMode(mode) : mode);
          sync();
        },
      },
      MODE_LABEL[mode],
    );
    buttons.set(mode, button);
    group.appendChild(button);
  }

  onThemeChange(sync);
  sync();
  return group;
}

export function renderHeader(): HTMLElement {
  const nav = h('nav', { class: 'site-nav', 'aria-label': '主导航' });

  const header = h(
    'header',
    { class: 'site-header' },
    h(
      'div',
      { class: 'container site-header__inner' },
      h(
        'a',
        { class: 'brand', href: '#/' },
        h('span', { class: 'brand__mark' }, '领域洞察雷达'),
        h('span', { class: 'brand__sub' }, 'Lab Insight Radar'),
      ),
      nav,
      themeToggle(),
    ),
  );

  const links = new Map<string, HTMLAnchorElement>();
  for (const item of NAV) {
    const link = h('a', { href: item.hash }, item.label);
    links.set(item.section, link);
    nav.appendChild(link);
  }

  header.dataset.links = 'ready';
  (header as HTMLElement & { syncNav?: (route: Route) => void }).syncNav = (route: Route) => {
    const active = activeSection(route);
    for (const [section, link] of links) {
      if (section === active) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    }
  };

  return header;
}

export function syncHeader(header: HTMLElement, route: Route): void {
  (header as HTMLElement & { syncNav?: (r: Route) => void }).syncNav?.(route);
}
