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
}
