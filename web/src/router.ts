/** hash 路由：GitHub Pages 是纯静态托管，hash 路由可避免深链接 404。 */

export type Route =
  | { name: 'overview' }
  | { name: 'domain'; slug: string }
  | { name: 'graph' }
  | { name: 'trends' }
  | { name: 'search'; q: string }
  | { name: 'archive' }
  | { name: 'report'; date: string }
  | { name: 'notfound'; path: string };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [pathPart = '/', queryPart = ''] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const query = new URLSearchParams(queryPart);

  if (segments.length === 0) return { name: 'overview' };
  switch (segments[0]) {
    case 'domain':
      return segments[1] ? { name: 'domain', slug: decodeURIComponent(segments[1]) } : { name: 'overview' };
    case 'search':
      return { name: 'search', q: query.get('q') ?? '' };
    case 'graph':
      return { name: 'graph' };
    case 'trends':
      return { name: 'trends' };
    case 'archive':
      return { name: 'archive' };
    case 'report':
      return segments[1] ? { name: 'report', date: segments[1] } : { name: 'archive' };
    default:
      return { name: 'notfound', path: pathPart };
  }
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'domain':
      return `#/domain/${encodeURIComponent(route.slug)}`;
    case 'search':
      return route.q ? `#/search?q=${encodeURIComponent(route.q)}` : '#/search';
    case 'graph':
      return '#/graph';
    case 'trends':
      return '#/trends';
    case 'archive':
      return '#/archive';
    case 'report':
      return `#/report/${route.date}`;
    case 'notfound':
      return `#${route.path}`;
    default:
      return '#/';
  }
}

export function onRouteChange(callback: (route: Route) => void): void {
  const handler = (): void => callback(parseHash(window.location.hash));
  window.addEventListener('hashchange', handler);
  handler();
}

export function navigate(route: Route): void {
  window.location.hash = routeToHash(route);
}

/** 导航高亮用的顶层分区名。 */
export function activeSection(route: Route): string {
  if (route.name === 'report') return 'archive';
  return route.name;
}
