/**
 * 展示层去重。
 *
 * 语料里同一篇文章会被多个公众号转发，也会被分类器同时归入多个领域，
 * 于是检索结果里会出现"同一天、同一标题、不同分类"的多条记录。
 * 数据层保留这些记录（多标签是有用信息），但在展示层按「日期 + 归一化标题」
 * 归并成一条，把分类合并成标签显示，避免用户看到重复。
 */

/** 标题归一化：去掉全部空白并小写，用于判定"同一篇"。 */
export function normalizeTitle(title: string): string {
  return title.replace(/[\s\u3000]+/g, '').toLowerCase();
}

export interface GroupableHit {
  date: string;
  title: string;
  category: string;
}

export interface GroupedHit<T> {
  hit: T;
  categories: string[];
  duplicated: number;
}

/**
 * 按 (日期, 归一化标题) 归并；保留首次出现的记录作为主记录，
 * 分类按出现顺序去重合并。输入顺序即优先级（调用方应先按相关度排好）。
 */
export function groupByArticle<T extends GroupableHit>(hits: T[]): GroupedHit<T>[] {
  const seen = new Map<string, GroupedHit<T>>();
  const order: string[] = [];

  for (const hit of hits) {
    const key = `${hit.date}|${normalizeTitle(hit.title)}`;
    const existing = seen.get(key);
    if (existing) {
      existing.duplicated += 1;
      if (!existing.categories.includes(hit.category)) existing.categories.push(hit.category);
      continue;
    }
    seen.set(key, { hit, categories: [hit.category], duplicated: 1 });
    order.push(key);
  }

  return order.map((key) => seen.get(key)!);
}
