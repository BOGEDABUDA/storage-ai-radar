"""汇总 papers.json + papers_cache.json → web/public/data/papers.json（前端消费）。

关键处理：
- 只保留 is_paper 的条目
- 同一篇论文在多期被反复推荐 → 归并成一条，合并日期/领域，摘要取最长的那份
  （语料里同一篇论文最多被推荐过 6 次，不归并会让"学术推荐"页一片重复）
- arXiv 解析结果按「先 ID 后标题」的优先级取用；ID 与论文名冲突时用标题检索的结果
- 无论是否解析成功，都提供 Google Scholar 与 arXiv 的搜索链接兜底
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from . import extract_papers, paths, resolve_papers

CST = timezone(timedelta(hours=8))
MAX_ABSTRACT = 1400

PAPERS_OUT = "papers.json"


def _scholar(title: str) -> str:
    return "https://scholar.google.com/scholar?q=" + _q(title)


def _arxiv_search(title: str) -> str:
    return "https://arxiv.org/search/?searchtype=all&query=" + _q(title)


def _q(text: str) -> str:
    from urllib.parse import quote_plus

    return quote_plus(text)


def build() -> dict:
    store = extract_papers.load_store()
    entries = store.get("entries", {})
    if not entries:
        return {"generated_at": None, "stats": {"papers": 0}, "papers": []}

    cache = resolve_papers.load_cache()
    queries = cache.get("queries", {})

    groups: dict[str, dict] = {}
    stats = defaultdict(int)

    for entry in entries.values():
        if not entry.get("is_paper"):
            continue
        stats["paper_entries"] += 1

        paper_title = (entry.get("paper_title") or "").strip()
        title_hint = (entry.get("title_hint") or "").strip()
        arxiv_id = entry.get("arxiv_id") or entry.get("arxiv_id_hint")

        # 按 resolve_papers 的优先级找解析结果
        resolved = None
        status = "unresolved"
        confidence = None
        candidate_keys: list[str] = []
        if arxiv_id:
            candidate_keys.append(f"id:{arxiv_id}")
        for name in (paper_title, title_hint):
            if name:
                candidate_keys.append(f"t:{resolve_papers._norm(name)}")
        for key in candidate_keys:
            record = queries.get(key)
            if not record:
                continue
            if record.get("match") and resolved is None:
                resolved = record["match"]
                status = record.get("status", "matched")
                confidence = record.get("score")
            elif resolved is None and status == "unresolved":
                status = record.get("status", "unresolved")

        if resolved:
            stats["resolved"] += 1
            if resolved.get("abstract"):
                stats["with_abstract"] += 1
        elif status in {"no_results", "not_found", "rejected", "id_conflict_unresolved"}:
            stats["unmatched"] += 1

        display_title = (resolved["title"] if resolved else (paper_title or title_hint)) or entry["report_title"]
        group_key = (
            f"arxiv:{resolved['arxiv_id']}"
            if resolved
            else f"t:{resolve_papers._norm(paper_title or title_hint or entry['report_title'])}"
        )

        target = groups.get(group_key)
        if target is None:
            target = {
                "id": group_key,
                "title": display_title,
                "report_title": entry["report_title"],
                "summary": entry.get("summary", ""),
                "paper_title": paper_title,
                "venue": entry.get("venue") or "",
                "year": entry.get("year"),
                "authors": entry.get("authors") or "",
                "arxiv_id": arxiv_id,
                "dates": [],
                "categories": [],
                "report_titles": [],
                "status": status,
                "confidence": confidence,
                "arxiv": None,
            }
            groups[group_key] = target

        # 合并多期推荐：摘要取最长，日期与领域取并集
        if len(entry.get("summary", "")) > len(target["summary"]):
            target["summary"] = entry["summary"]
        if entry["date"] not in target["dates"]:
            target["dates"].append(entry["date"])
        if entry["category"] not in target["categories"]:
            target["categories"].append(entry["category"])
        if entry["report_title"] not in target["report_titles"] and len(target["report_titles"]) < 6:
            target["report_titles"].append(entry["report_title"])
        if not target["venue"] and entry.get("venue"):
            target["venue"] = entry["venue"]
        if not target["year"] and entry.get("year"):
            target["year"] = entry["year"]
        if resolved and not target["arxiv"]:
            target["arxiv"] = {
                "id": resolved["arxiv_id"],
                "title": resolved["title"],
                "abstract": (resolved.get("abstract") or "")[:MAX_ABSTRACT],
                "published": resolved.get("published"),
                "authors": (resolved.get("authors") or [])[:8],
                "categories": resolved.get("categories") or [],
                "journal_ref": resolved.get("journal_ref"),
                "url": f"https://arxiv.org/abs/{resolved['arxiv_id']}",
            }
            target["status"] = status
            target["confidence"] = confidence
            if not paper_title:
                target["paper_title"] = resolved["title"]

    papers = []
    for target in groups.values():
        target["dates"].sort(reverse=True)
        query_title = target["arxiv"]["title"] if target["arxiv"] else (target["paper_title"] or target["report_title"])
        target["links"] = {
            "arxiv_abs": target["arxiv"]["url"] if target["arxiv"] else None,
            "arxiv_pdf": f"https://arxiv.org/pdf/{target['arxiv']['id']}" if target["arxiv"] else None,
            "scholar": _scholar(query_title),
            "arxiv_search": _arxiv_search(query_title),
        }
        target["primary_date"] = target["dates"][0] if target["dates"] else None
        target["primary_category"] = target["categories"][0] if target["categories"] else "others"
        papers.append(target)

    # 排序：已匹配到 arXiv 的（有真实标题与英文摘要）排前面，其次按最近推荐日期
    papers.sort(key=lambda p: p["primary_date"] or "", reverse=True)
    papers.sort(key=lambda p: p["arxiv"] is None)

    return {
        "generated_at": datetime.now(CST).isoformat(timespec="seconds"),
        "stats": {
            "paper_entries": stats["paper_entries"],
            "unique_papers": len(papers),
            "resolved": sum(1 for p in papers if p["arxiv"]),
            "with_abstract": sum(1 for p in papers if p["arxiv"] and p["arxiv"]["abstract"]),
            "unmatched": sum(1 for p in papers if not p["arxiv"]),
        },
        "papers": papers,
    }


def main() -> int:
    from .build import _write_json

    payload = build()
    size = _write_json(paths.WEB_DATA_DIR / PAPERS_OUT, payload, compact=True)
    stats = payload["stats"]
    print(
        f"[论文] 论文推荐条目 {stats['paper_entries']} → 唯一论文 {stats['unique_papers']}，"
        f"arXiv 命中 {stats['resolved']}（含摘要 {stats['with_abstract']}），未匹配 {stats['unmatched']}"
    )
    print(f"[论文] {size / 1024:.0f} KB → {paths.WEB_DATA_DIR / PAPERS_OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
