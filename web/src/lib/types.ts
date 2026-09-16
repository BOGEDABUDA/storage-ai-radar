/** 产物数据契约（与 pipeline/build.py 的输出一一对应）。 */

export type Perspective = 'business' | 'technical' | 'topic';
export type Section = 'regular' | 'paper';

export interface CategoryMeta {
  key: string;
  name: string;
  article_count: number;
  digest_count: number;
  first_seen: string | null;
  last_seen: string | null;
  is_catch_all: boolean;
}

export interface Manifest {
  generated_at: string;
  source_label: string;
  report_count: number;
  article_count: number;
  digest_count: number;
  detail_count: number;
  sources_attached: number;
  empty_summaries: number;
  dates: string[];
  categories: CategoryMeta[];
  index_fields: string[];
}

export interface SourceLink {
  title: string;
  url: string;
}

export interface Digest {
  id: string;
  date: string;
  category: string;
  category_name: string;
  perspective: Perspective;
  topic: string;
  heading_raw: string;
  text: string;
  sources: SourceLink[];
}

export interface Article {
  id: string;
  date: string;
  category: string;
  category_name: string;
  section: Section;
  section_raw: string;
  title: string;
  time_hint: string;
  summary: string;
}

export interface TimelineSeries {
  category: string;
  category_name: string;
  is_catch_all: boolean;
  article_counts: number[];
  digest_counts: number[];
}

export interface Timeline {
  dates: string[];
  series: TimelineSeries[];
}

export interface IndexFile {
  fields: string[];
  /** [id, date, category, section, title, lead] */
  rows: [string, string, string, Section, string, string][];
}

export interface SearchHit {
  id: string;
  date: string;
  category: string;
  section: Section;
  title: string;
  snippet: string;
  score: number;
  /** 展示层归并后，该文被归入的全部领域（含 category 本身） */
  categories?: string[];
  /** 归并掉的重复条数（含自身） */
  duplicated?: number;
}

/* ------------------------------------------------------------------ P2：图谱与趋势 */

export type EntityType = 'company' | 'institution' | 'tech' | 'product' | 'paper' | 'person' | 'metric' | 'category';

export interface GraphNode {
  id: string;
  label: string;
  kind: 'entity' | 'category';
  etype: EntityType;
  category: string;
  mentions: number;
  /** 实体节点才有 */
  first_seen?: string;
  last_seen?: string;
  business?: number;
  technical?: number;
  /** 42 期提及次数 */
  series?: number[];
  digests?: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: 'co_occurs' | 'belongs_to';
  weight: number;
}

export interface GraphFile {
  generated_at: string;
  model?: string;
  dates: string[];
  stats: {
    digests: number;
    entities_total: number;
    entities_in_graph: number;
    edges: number;
    min_mentions: number;
    min_cooccur: number;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface TrendCategory {
  category: string;
  name: string;
  is_catch_all: boolean;
  momentum: number;
  direction: 'up' | 'flat' | 'down';
  recent_articles: number;
  baseline_articles: number;
  article_counts: number[];
  digest_counts: number[];
  business: number;
  technical: number;
  topic: number;
}

export interface TrendEntity {
  id: string;
  label: string;
  etype: EntityType;
  category: string;
  mentions: number;
  recent: number;
  baseline: number;
  momentum: number;
  first_seen: string;
}

export interface MetricSeries {
  key: string;
  subject: string;
  label: string;
  unit: string | null;
  count: number;
  points: { date: string; value: number }[];
  first: number;
  last: number;
  change: number | null;
}

export interface MetricObservationGroup {
  label: string;
  unit: string | null;
  count: number;
  subjects: number;
  observations: { date: string; subject: string; value: number; unit: string | null }[];
}

export interface EntityPerspective {
  id: string;
  label: string;
  etype: EntityType;
  category: string;
  mentions: number;
  business: number;
  technical: number;
  /** (商业 − 学术) / 总数，+1 全商业，−1 全学术 */
  lean: number;
}

export interface TrendsFile {
  generated_at: string;
  window: { recent: number; baseline: number };
  categories: TrendCategory[];
  rising_entities: TrendEntity[];
  new_entities: TrendEntity[];
  fading_entities: TrendEntity[];
  metrics: MetricSeries[];
  metric_observations: MetricObservationGroup[];
  entity_perspective: EntityPerspective[];
}

/* ------------------------------------------------------------------ 学术论文推荐 */

export interface PaperArxiv {
  id: string;
  title: string;
  abstract: string;
  published: string | null;
  authors: string[];
  categories: string[];
  journal_ref: string | null;
  url: string;
}

export interface PaperLinks {
  arxiv_abs: string | null;
  arxiv_pdf: string | null;
  scholar: string;
  arxiv_search: string;
}

export interface Paper {
  id: string;
  /** 展示用标题：优先 arXiv 真实标题，其次抽出的论文名，最后回落媒体标题 */
  title: string;
  report_title: string;
  summary: string;
  paper_title: string;
  venue: string;
  year: number | null;
  authors: string;
  arxiv_id: string | null;
  dates: string[];
  categories: string[];
  report_titles: string[];
  status: string;
  confidence: number | null;
  arxiv: PaperArxiv | null;
  links: PaperLinks;
  primary_date: string | null;
  primary_category: string;
}

export interface PapersFile {
  generated_at: string | null;
  stats: {
    paper_entries: number;
    unique_papers: number;
    resolved: number;
    with_abstract: number;
    unmatched: number;
  };
  papers: Paper[];
}
