/** 数据加载：派生数据是静态 JSON，全部按 BASE_URL 前缀取用并做内存缓存。 */

import type { Article, Digest, IndexFile, Manifest, Timeline } from './types';

const cache = new Map<string, Promise<unknown>>();

function baseUrl(): string {
  return import.meta.env.BASE_URL || '/';
}

async function getJSON<T>(relative: string): Promise<T> {
  const url = `${baseUrl()}data/${relative}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`加载失败 ${response.status}：${url}`);
  }
  return (await response.json()) as T;
}

function cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  let entry = cache.get(key);
  if (!entry) {
    entry = loader();
    cache.set(key, entry);
  }
  return entry as Promise<T>;
}

export function loadManifest(): Promise<Manifest> {
  return cached('manifest', () => getJSON<Manifest>('manifest.json'));
}

export function loadDigests(): Promise<Digest[]> {
  return cached('digests', () => getJSON<Digest[]>('digests.json'));
}

export function loadTimeline(): Promise<Timeline> {
  return cached('timeline', () => getJSON<Timeline>('timeline.json'));
}

export function loadIndex(): Promise<IndexFile> {
  return cached('index', () => getJSON<IndexFile>('articles.index.json'));
}

export function loadShard(date: string): Promise<Article[]> {
  return cached(`shard:${date}`, () => getJSON<Article[]>(`articles/${date}.json`));
}

/** 取某分类的 CSS 变量色值。 */
export function categoryColor(key: string): string {
  return `var(--cat-${key}, var(--accent))`;
}

export function categoryName(manifest: Manifest, key: string): string {
  return manifest.categories.find((c) => c.key === key)?.name ?? key;
}
