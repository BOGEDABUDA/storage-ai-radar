"""arXiv 解析：把抽出的论文名解析成真实论文（标题/摘要/作者/直链）。

三种输入来源，优先级从高到低：
  1. 摘要里直接给出的 arXiv 编号 → 直接按 ID 取元数据，零歧义
  2. 正则从书名号里抽出的英文标题 → 标题检索 + 相似度匹配
  3. LLM 抽出的论文名/方法名 → 标题检索；方法名（如 EvoRAG）改用全字段检索，
     并要求词面出现在返回标题里

限速：arXiv 官方建议不超过 1 请求/3 秒，这里严格遵守。
缓存：`pipeline/papers_cache.json`（提交进仓库），可随时中断续跑。

用法：
    python3 -m pipeline.resolve_papers                 # 续跑（跳过已解析）
    python3 -m pipeline.resolve_papers --limit 50      # 只跑 50 条
    python3 -m pipeline.resolve_papers --only-ids      # 只解析有 arXiv ID 的（最快）
    python3 -m pipeline.resolve_papers --retry-failed  # 重试此前判定为未匹配的
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import extract_papers, paths

CST = timezone(timedelta(hours=8))
CACHE_PATH = paths.PROJECT_ROOT / "pipeline" / "papers_cache.json"
API = "https://export.arxiv.org/api/query"
ATOM = "{http://www.w3.org/2005/Atom}"
ARXIV_NS = "{http://arxiv.org/schemas/atom}"
RATE_LIMIT_SECONDS = 3.0
MATCH_THRESHOLD = 0.82
# 本语料是「存储 / AI 基础设施」。高能物理、天体物理等领域的论文标题里常含
# 与 AI 方法同名的通用词（实测：AI 方法 "ATLAS" 命中了希格斯玻色子论文），
# 因此对明显无关的 arXiv 主分类直接拒配。
UNRELATED_PREFIXES = ("hep-", "astro-ph", "nucl-", "gr-qc")
# 短方法名本身歧义大，只接受 AI/信号处理/统计机器学习方向的匹配
METHOD_ALLOWED_PREFIXES = ("cs.", "eess.", "stat.")
MAX_RESULTS = 6
USER_AGENT = "LabInsightRadar/1.0 (research corpus tooling)"


def _norm(text: str) -> str:
    """归一化：小写、去标点、压缩空白。

    必须保留 CJK 字符 —— 之前只保留 [a-z0-9]，导致所有中文论文标题都归一化成空串，
    于是它们在缓存里共享同一个 key `t:`，一篇的解析结果会被套用到所有中文论文上。
    """
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", str(text).lower()).strip()


def _similarity(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, _norm(a), _norm(b)).ratio()


def _title_agrees(llm_title: str, resolved_title: str) -> bool:
    """判断抽出的论文名与 arXiv 返回标题是否指同一篇。

    短方法名（AgentDoG 1.5、EvoRAG）往往是完整标题的前缀，单看编辑距离会误判，
    因此先做「词面包含」判定，再退回相似度。
    """
    a, b = _norm(llm_title), _norm(resolved_title)
    if not a or not b:
        return True
    if a in b or b in a:
        return True
    tokens = a.split()
    # 允许抽出的名字开头带缩写或冠词（"AHE (Agentic Harness Engineering)"
    # 归一化后是 "ahe agentic harness engineering"，去掉首词即与标题一致）
    for start in (1, 2):
        if start < len(tokens):
            tail = " ".join(tokens[start:])
            if len(tail) >= 12 and tail in b:
                return True
    # 方法名的首个有辨识度的词出现在标题里也算一致（如 "EvoRAG" → "EvoRAG: ..."）
    head = tokens[0]
    if len(head) >= 4 and head in b:
        return True
    # 中英混排的抽取结果（"大模型记忆操作系统 MemoryOS"）里，
    # 只要有辨识度的英文词出现在标题中，就认为指同一篇
    for token in tokens:
        if len(token) >= 5 and token.isascii() and token in b:
            return True
    return _similarity(llm_title, resolved_title) >= 0.5


def _unrelated(candidate: dict) -> bool:
    """候选论文是否属于与本语料明显无关的领域。"""
    categories = candidate.get("categories") or []
    primary = (categories[0] if categories else "") or ""
    return any(primary.startswith(prefix) for prefix in UNRELATED_PREFIXES)


def _method_domain_ok(candidate: dict) -> bool:
    categories = candidate.get("categories") or []
    primary = (categories[0] if categories else "") or ""
    if not primary:
        return True  # 没拿到分类信息时不额外拦截，靠后续词面判定
    return any(primary.startswith(prefix) for prefix in METHOD_ALLOWED_PREFIXES)


def _looks_like_full_title(name: str) -> bool:
    """只有"像完整论文标题"的抽取结果才值得用来质疑 arXiv 编号。

    短方法名（AFlex、AHE、ATLAS、BiasLens）常常不出现在论文标题里，
    用它们做一致性校验会造成大量误判；而编号是从摘要正文里直接读到的，
    可信度远高于 LLM 归纳出的短名。
    """
    words = [w for w in re.split(r"\s+", name.strip()) if w]
    return len(name.strip()) >= 25 and len(words) >= 4


def _is_method_name(name: str) -> bool:
    """短方法名（EvoRAG、MemoryOS）用精确检索效果差，改用全字段检索 + 词面判定。"""
    words = [w for w in re.split(r"\s+", name.strip()) if w]
    return len(words) <= 2 and len(name) <= 24


def load_cache() -> dict:
    if CACHE_PATH.is_file():
        try:
            data = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
            if data.get("version") == 1:
                return data
        except json.JSONDecodeError:
            pass
    return {"version": 1, "generated_at": None, "queries": {}}


def save_cache(cache: dict) -> None:
    paths.assert_writable(CACHE_PATH)
    cache["generated_at"] = datetime.now(CST).isoformat(timespec="seconds")
    CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")


def collect_targets(store: dict) -> list[dict]:
    """把 papers.json 里的条目归并成待解析的唯一论文列表。"""
    targets: dict[str, dict] = {}

    def add(key: str, *, title: str, arxiv_id: str | None, kind: str, label: str,
            llm_title: str = "", alt_title: str = "") -> None:
        existing = targets.get(key)
        if existing is None:
            targets[key] = {
                "key": key,
                "title": title,
                "llm_title": llm_title,
                "alt_title": alt_title,
                "arxiv_id": arxiv_id,
                "kind": kind,  # id | title | method
                "labels": [label],
            }
        else:
            if label not in existing["labels"]:
                existing["labels"].append(label)
            if not existing.get("llm_title") and llm_title:
                existing["llm_title"] = llm_title
            if not existing.get("alt_title") and alt_title:
                existing["alt_title"] = alt_title

    for entry in store.get("entries", {}).values():
        # 1) 显式 arXiv 编号（LLM 抽到的优先，其次正则）
        paper_title = entry.get("paper_title") or ""
        title_hint = entry.get("title_hint") or ""
        arxiv_id = entry.get("arxiv_id") or entry.get("arxiv_id_hint")
        if arxiv_id:
            add(
                f"id:{arxiv_id}",
                title=paper_title or title_hint or entry.get("report_title", ""),
                arxiv_id=arxiv_id,
                kind="id",
                label=entry.get("report_title", ""),
                llm_title=paper_title,
                alt_title=title_hint,
            )
            # 同时登记标题检索目标：ID 与论文名不一致时可回退
            if paper_title:
                kind = "method" if _is_method_name(paper_title) else "title"
                add(f"t:{_norm(paper_title)}", title=paper_title, arxiv_id=None, kind=kind,
                    label=entry.get("report_title", ""), llm_title=paper_title)
            continue
        # 2) 正则抽出的英文标题
        if title_hint:
            add(f"t:{_norm(title_hint)}", title=title_hint, arxiv_id=None, kind="title",
                label=entry.get("report_title", ""), llm_title=paper_title)
        # 3) LLM 抽出的论文名
        if paper_title and entry.get("is_paper"):
            kind = "method" if _is_method_name(paper_title) else "title"
            add(f"t:{_norm(paper_title)}", title=paper_title, arxiv_id=None, kind=kind,
                label=entry.get("report_title", ""), llm_title=paper_title)

    return sorted(targets.values(), key=lambda t: (t["kind"] != "id", t["title"]))


def _fetch(params: dict, retries: int = 3) -> str | None:
    url = f"{API}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read().decode("utf-8", errors="replace")
        except Exception as exc:  # noqa: BLE001
            if attempt == retries:
                print(f"    [网络失败] {type(exc).__name__}: {exc}", flush=True)
                return None
            time.sleep(5 * attempt)
    return None


def _parse_atom(xml: str) -> list[dict]:
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return []
    out = []
    for entry in root.findall(f"{ATOM}entry"):
        raw_id = (entry.findtext(f"{ATOM}id") or "").strip()
        match = re.search(r"abs/([\d.]+)(v\d+)?", raw_id)
        if not match:
            continue
        out.append(
            {
                "arxiv_id": match.group(1),
                "version": (match.group(2) or "").lstrip("v") or None,
                "title": re.sub(r"\s+", " ", entry.findtext(f"{ATOM}title") or "").strip(),
                "abstract": re.sub(r"\s+", " ", entry.findtext(f"{ATOM}summary") or "").strip(),
                "published": (entry.findtext(f"{ATOM}published") or "")[:10] or None,
                "updated": (entry.findtext(f"{ATOM}updated") or "")[:10] or None,
                "authors": [a.findtext(f"{ATOM}name") for a in entry.findall(f"{ATOM}author")][:12],
                "categories": [c.get("term") for c in entry.findall(f"{ATOM}category")][:6],
                "journal_ref": (entry.findtext(f"{ARXIV_NS}journal_ref") or "").strip() or None,
                "comment": (entry.findtext(f"{ARXIV_NS}comment") or "").strip()[:200] or None,
            }
        )
    return out


def query_arxiv(target: dict) -> dict:
    """返回 {status, query, match}。"""
    if target["arxiv_id"]:
        xml = _fetch({"id_list": target["arxiv_id"], "max_results": "1"})
        if not xml:
            return {"status": "network_error", "query": f"id_list={target['arxiv_id']}", "match": None}
        results = _parse_atom(xml)
        if not results:
            return {"status": "not_found", "query": f"id_list={target['arxiv_id']}", "match": None}
        resolved = results[0]
        if _unrelated(resolved):
            return {"status": "rejected_domain", "query": f"id_list={target['arxiv_id']}",
                    "match": None, "best_candidate": resolved["title"]}
        # 一致性校验：摘要里的 arXiv 编号可能指向同一段文字里提到的**另一篇**论文。
        # 若我们同时抽到了论文名，而它与该编号对应的标题差异很大，就判定冲突，
        # 改为按标题检索，避免给出错误的论文链接。
        llm_title = target.get("llm_title") or ""
        if llm_title and _looks_like_full_title(llm_title):
            score = _similarity(llm_title, resolved["title"])
            if not _title_agrees(llm_title, resolved["title"]):
                fallback = query_arxiv({**target, "arxiv_id": None,
                                        "kind": "method" if _is_method_name(llm_title) else "title",
                                        "title": llm_title})
                if fallback.get("match"):
                    fallback["status"] = "matched_by_title_over_id"
                    fallback["id_conflict"] = {
                        "hint_id": target["arxiv_id"],
                        "hint_title": resolved["title"],
                        "llm_title": llm_title,
                        "similarity": round(score, 3),
                    }
                    return fallback
                return {
                    "status": "id_conflict_unresolved",
                    "query": f"id_list={target['arxiv_id']}",
                    "match": None,
                    "conflict": {"hint_id": target["arxiv_id"], "hint_title": resolved["title"],
                                 "llm_title": llm_title, "similarity": round(score, 3)},
                }
        return {"status": "matched_by_id", "query": f"id_list={target['arxiv_id']}",
                "match": resolved, "score": 1.0}

    title = target["title"]
    field = "all" if target["kind"] == "method" else "ti"
    query = f'{field}:"{title}"'
    xml = _fetch({"search_query": query, "max_results": str(MAX_RESULTS)})
    if not xml:
        return {"status": "network_error", "query": query, "match": None}
    results = _parse_atom(xml)
    if not results:
        return {"status": "no_results", "query": query, "match": None}

    best, best_score = None, 0.0
    for candidate in results:
        if _unrelated(candidate):
            continue
        if target["kind"] == "method":
            # 方法名：既要词面出现在标题里，也必须是 AI/信号处理方向，
            # 否则 "ATLAS" 这类通用词会命中高能物理等同名论文
            if not _method_domain_ok(candidate):
                continue
            if _norm(title) and _norm(title) in _norm(candidate["title"]):
                score = 0.95
            else:
                continue
        else:
            score = _similarity(title, candidate["title"])
        if score > best_score:
            best, best_score = candidate, score

    if best is None:
        return {"status": "rejected", "query": query, "match": None,
                "best_candidate": results[0]["title"], "best_score": round(_similarity(title, results[0]["title"]), 3)}
    if best_score >= MATCH_THRESHOLD:
        return {"status": "matched_by_title", "query": query, "match": best, "score": round(best_score, 3)}
    return {"status": "rejected", "query": query, "match": None,
            "best_candidate": best["title"], "best_score": round(best_score, 3)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="用 arXiv API 解析论文（限速 1 请求/3 秒，可续跑）")
    parser.add_argument("--limit", type=int, default=0, help="本次最多解析多少条")
    parser.add_argument("--only-ids", action="store_true", help="只解析带 arXiv 编号的（最准最快）")
    parser.add_argument("--retry-failed", action="store_true", help="重试未匹配/网络失败的")
    parser.add_argument("--rate", type=float, default=RATE_LIMIT_SECONDS, help="请求间隔秒数")
    args = parser.parse_args(argv)

    store = extract_papers.load_store()
    if not store["entries"]:
        print("[错误] pipeline/papers.json 为空，请先运行 python3 -m pipeline.extract_papers")
        return 1

    targets = collect_targets(store)
    if args.only_ids:
        targets = [t for t in targets if t["kind"] == "id"]

    cache = load_cache()
    queries: dict[str, dict] = cache["queries"]

    todo = []
    for target in targets:
        cached = queries.get(target["key"])
        if cached is None:
            todo.append(target)
        elif args.retry_failed and cached.get("status") in {
            "not_found",
            "no_results",
            "rejected",
            "rejected_domain",
            "id_conflict_unresolved",
            "network_error",
        }:
            todo.append(target)

    print(f"[解析] 唯一论文 {len(targets)} 条，待处理 {len(todo)} 条（限速 {args.rate}s/请求）")
    if not todo:
        print("[解析] 没有需要处理的条目")
        return 0

    if args.limit:
        todo = todo[: args.limit]

    matched = 0
    started = time.time()
    for index, target in enumerate(todo, 1):
        if index > 1:
            time.sleep(args.rate)
        result = query_arxiv(target)
        result["title"] = target["title"]
        result["kind"] = target["kind"]
        result["checked_at"] = datetime.now(CST).isoformat(timespec="seconds")
        queries[target["key"]] = result
        if result["match"]:
            matched += 1
        if index % 10 == 0 or index == len(todo):
            save_cache(cache)
            elapsed = time.time() - started
            rate = index / elapsed if elapsed else 0
            remain = (len(todo) - index) / rate if rate else 0
            print(
                f"  [{index}/{len(todo)}] 命中 {matched} · 已用 {elapsed / 60:.1f} 分钟 · 预计剩余 {remain / 60:.1f} 分钟",
                flush=True,
            )

    save_cache(cache)
    hit = sum(1 for q in queries.values() if q.get("match"))
    print(f"[完成] 本次解析 {len(todo)} 条，命中 {matched} 条")
    print(f"[累计] 已解析 {len(queries)} 条，其中命中 {hit} 条 → {CACHE_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
