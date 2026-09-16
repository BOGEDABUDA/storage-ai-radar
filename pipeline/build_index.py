"""构建 insight.sqlite：Agent 检索用的全文索引（本机使用，不进仓库）。

两张检索表：
- digests_fts   794 条精选洞察（题 + 正文）
- articles_fts  15,192 篇文章摘要（标题 + 摘要）

中文用 FTS5 trigram 分词（无需外部分词器）。

为什么原始正文不入库：articles/ 有 353 MB，trigram 索引体积约为正文的 4~5 倍（实测核心
21 MB 文本 → 96.6 MB 索引），全量入库会产生 ~1.6 GB 索引。原始正文本来就以只读方式躺在
磁盘上，Agent 在「点击深挖」时按日期读取对应目录即可，既不重复存储，也天然保持只读。

用法：
    python3 -m pipeline.build_index
"""

from __future__ import annotations

import json
import sqlite3
import sys
import time
from datetime import datetime, timedelta, timezone

from . import parse_articles, parse_digest, paths

CST = timezone(timedelta(hours=8))
DB_PATH = paths.PROJECT_ROOT / "insight.sqlite"

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS digests(
  id TEXT PRIMARY KEY, date TEXT, category TEXT, category_name TEXT,
  perspective TEXT, topic TEXT, text TEXT, sources TEXT
);
CREATE TABLE IF NOT EXISTS articles(
  id TEXT PRIMARY KEY, date TEXT, category TEXT, category_name TEXT,
  section TEXT, title TEXT, time_hint TEXT, summary TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS digests_fts
  USING fts5(id UNINDEXED, topic, text, tokenize='trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts
  USING fts5(id UNINDEXED, title, summary, tokenize='trigram');

CREATE INDEX IF NOT EXISTS idx_articles_date ON articles(date);
CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category);
CREATE INDEX IF NOT EXISTS idx_digests_date ON digests(date);
CREATE INDEX IF NOT EXISTS idx_digests_category ON digests(category);
"""

TABLES = ("digests", "articles", "digests_fts", "articles_fts", "meta")


def build() -> dict:
    paths.assert_writable(DB_PATH)
    if DB_PATH.exists():
        DB_PATH.unlink()
    for suffix in ("-wal", "-shm"):
        sidecar = DB_PATH.with_name(DB_PATH.name + suffix)
        if sidecar.exists():
            sidecar.unlink()

    source = paths.source_dir()
    started = time.time()

    digests, w1 = parse_digest.parse_all(source)
    articles, w2 = parse_articles.parse_all(source)

    conn = sqlite3.connect(DB_PATH)
    try:
        conn.executescript(SCHEMA)
        for table in TABLES:
            conn.execute(f"DELETE FROM {table}")

        conn.executemany(
            "INSERT INTO digests(id,date,category,category_name,perspective,topic,text,sources)"
            " VALUES(?,?,?,?,?,?,?,?)",
            [
                (
                    d["id"],
                    d["date"],
                    d["category"],
                    d["category_name"],
                    d["perspective"],
                    d["topic"],
                    d["text"],
                    json.dumps(d["sources"], ensure_ascii=False),
                )
                for d in digests
            ],
        )
        conn.executemany(
            "INSERT INTO digests_fts(id,topic,text) VALUES(?,?,?)",
            [(d["id"], d["topic"], d["text"]) for d in digests],
        )
        conn.executemany(
            "INSERT INTO articles(id,date,category,category_name,section,title,time_hint,summary)"
            " VALUES(?,?,?,?,?,?,?,?)",
            [
                (
                    a["id"],
                    a["date"],
                    a["category"],
                    a["category_name"],
                    a["section"],
                    a["title"],
                    a["time_hint"],
                    a["summary"],
                )
                for a in articles
            ],
        )
        conn.executemany(
            "INSERT INTO articles_fts(id,title,summary) VALUES(?,?,?)",
            [(a["id"], a["title"], a["summary"]) for a in articles],
        )
        conn.executemany(
            "INSERT INTO meta(key,value) VALUES(?,?)",
            [
                ("generated_at", datetime.now(CST).isoformat(timespec="seconds")),
                ("digests", str(len(digests))),
                ("articles", str(len(articles))),
            ],
        )
        conn.commit()
        # 合并 b-tree 段，显著缩小索引并加快查询
        conn.execute("INSERT INTO digests_fts(digests_fts) VALUES('optimize')")
        conn.execute("INSERT INTO articles_fts(articles_fts) VALUES('optimize')")
        conn.commit()
        conn.execute("VACUUM")
    finally:
        conn.close()

    return {
        "db": str(DB_PATH),
        "digests": len(digests),
        "articles": len(articles),
        "bytes": DB_PATH.stat().st_size,
        "seconds": round(time.time() - started, 1),
        "warnings": w1 + w2,
    }


def main() -> int:
    report = build()
    print(f"[索引完成] 洞察 {report['digests']} · 文章 {report['articles']}")
    print(f"[索引体积] {report['bytes'] / 1024 / 1024:.1f} MB → {report['db']}")
    print(f"[耗时] {report['seconds']}s")
    for warning in report["warnings"][:5]:
        print(f"[告警] {warning}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
