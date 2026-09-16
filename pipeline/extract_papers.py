"""论文抽取：从「论文推荐」板块的摘要里抽出所引用论文的身份信息。

背景：`total/<date>/<分类>.md` 的 `## 📖 论文推荐` 板块里存的是**中文科技媒体文章标题**，
不是论文标题；真正的论文名嵌在摘要正文里（如「论文《The Memory Processing Unit: ...》」）。
因此需要两步：
  1. 正则预抽：arXiv 编号、书名号内的英文标题（快、免费、确定）
  2. LLM 抽取：对每条摘要判断是否指向某一篇具体论文，并抽出标题/会议/年份/作者

结果存 `pipeline/papers.json`（提交进仓库，使后续 arXiv 解析可离线复现），
按内容 SHA-256 增量更新，改摘要只重抽变化的部分。

用法：
    python3 -m pipeline.extract_papers            # 增量抽取
    python3 -m pipeline.extract_papers --force    # 全量重抽
    python3 -m pipeline.extract_papers --limit 40 # 试跑
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import categories, mdparse, paths

CST = timezone(timedelta(hours=8))
PAPERS_PATH = paths.PROJECT_ROOT / "pipeline" / "papers.json"
CACHE_VERSION = 1
DEFAULT_MODEL = "deepseek-v4-flash"
API_ENDPOINT = "https://api.deepseek.com/v1/chat/completions"
MAX_TOKENS = 131072
BATCH_SIZE = 20
CONCURRENCY = 5
MAX_RETRIES = 3

PAPER_SECTION = "论文推荐"
ARXIV_ID_RE = re.compile(r"arXiv[:\s]*(\d{4}\.\d{4,5})(?:v\d+)?", re.I)
BOOK_TITLE_RE = re.compile(r"《([^》]{6,200})》")

SYSTEM_PROMPT = "你是学术文献信息抽取引擎。只输出严格 JSON，不含解释或 markdown 代码块。"

USER_TEMPLATE = """下面每一条是「存储 / AI 基础设施」领域的中文科技媒体摘要。请判断该条是否在介绍某一篇**具体学术论文**，并抽取该论文的身份信息。

每条输出字段：
- is_paper：布尔。仅当该条确实指向某一篇可识别的学术论文（会议/期刊论文、arXiv 预印本、技术报告）时为 true。纯产品发布、公司动态、行业综述、工具介绍、多篇论文速览合集都算 false。
- paper_title：论文**原始标题或可检索名**。优先级：① 英文原名（不要中文译名）② 摘要里给出的方法名/系统名/模型名（如 EvoRAG、MaxKernel、MemoryOS、TriAttention、Attention Is All You Need）③ 中文原标题。去掉书名号与引号。只有当摘要通篇没有任何可指代该论文的名称时才留空字符串。宁可填方法名，也不要留空。
- venue：发表会议/期刊（如 ISCA 2026、NeurIPS、ACL 2026、Nature、VLSI 2026）；未提及留空。
- year：发表年份整数；未提及填 null。
- authors：作者或团队（如「斯坦福团队」「Karpathy」「北大杨玉超团队」）；未提及留空。
- arxiv_id：摘要中出现的 arXiv 编号（形如 2604.19673）；没有填 null。

严格按此格式输出，必须为每一条输入返回一个 results 条目，idx 与输入编号一致，不得跳过：
{{"results":[{{"idx":0,"is_paper":true,"paper_title":"The Memory Processing Unit: A Generalized Interface for End-to-End In-Memory Computing","venue":"ISCA 2026","year":2026,"authors":"","arxiv_id":null}}]}}

输入条目：
{items}"""


def _entry_hash(entry: dict) -> str:
    raw = f"{entry['report_title']}\x1f{entry['summary']}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def parse_paper_entries(source: Path) -> tuple[list[dict], list[str]]:
    """解析所有 total/*/*.md 的「论文推荐」板块。"""
    warnings: list[str] = []
    entries: list[dict] = []
    total_dir = source / "total"
    for date_dir in sorted(p for p in total_dir.iterdir() if p.is_dir()):
        date = date_dir.name
        for md in sorted(date_dir.glob("*.md")):
            category_name = md.stem
            slug = categories.slug_for(category_name)
            try:
                text = md.read_text(encoding="utf-8", errors="replace")
            except OSError as exc:
                warnings.append(f"{date}/{md.name}: 读取失败 {exc}")
                continue
            marker = f"## 📖 {PAPER_SECTION}"
            if marker not in text:
                continue
            segment = text.split(marker, 1)[1]
            index = 0
            for block in re.split(r"\n---\n", segment):
                if "**标题**" not in block:
                    continue
                title = re.search(r"\*\*标题\*\*[：:]\s*(.+)", block)
                summary = re.search(r"\*\*总结\*\*[：:]\s*(.+)", block, re.S)
                if not title:
                    continue
                report_title = title.group(1).strip()
                body = mdparse.clean(summary.group(1)) if summary else ""
                arxiv_hint = ARXIV_ID_RE.search(body)
                title_hint = ""
                for candidate in BOOK_TITLE_RE.findall(body):
                    # 书名号里要含足够英文才可能是论文原名（排除《自然》这类刊名）
                    if len(re.findall(r"[A-Za-z]", candidate)) >= 8:
                        title_hint = candidate.strip()
                        break
                entries.append(
                    {
                        "id": f"{date}|{slug}|{index}",
                        "date": date,
                        "category": slug,
                        "category_name": category_name,
                        "report_title": report_title,
                        "summary": body,
                        "arxiv_id_hint": arxiv_hint.group(1) if arxiv_hint else None,
                        "title_hint": title_hint or None,
                    }
                )
                index += 1
    return entries, warnings


def _item_text(index: int, entry: dict) -> str:
    return f"[{index}] 媒体标题：{entry['report_title']}\n摘要：{entry['summary']}"


def _resolve_api_key(explicit: str | None) -> str:
    from .extract_entities import resolve_api_key

    return resolve_api_key(explicit)


def call_llm(items: str, api_key: str, model: str) -> str:
    prompt = USER_TEMPLATE.replace("{items}", items)
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "max_tokens": MAX_TOKENS,
        "response_format": {"type": "json_object"},
    }
    request = urllib.request.Request(
        API_ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.load(response)["choices"][0]["message"]["content"]


def parse_response(raw: str) -> dict[int, dict]:
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("响应中找不到 JSON 对象")
    data = json.loads(text[start : end + 1])

    out: dict[int, dict] = {}
    for row in data.get("results", []):
        try:
            index = int(row["idx"])
        except (KeyError, TypeError, ValueError):
            continue
        title = str(row.get("paper_title") or "").strip().strip("《》\"'")[:300]
        year = row.get("year")
        try:
            year = int(year) if year is not None else None
        except (TypeError, ValueError):
            year = None
        arxiv = row.get("arxiv_id")
        arxiv = re.sub(r"[^\d.]", "", str(arxiv)) if arxiv else None
        out[index] = {
            "is_paper": bool(row.get("is_paper")),
            "paper_title": title,
            "venue": str(row.get("venue") or "").strip()[:80],
            "year": year,
            "authors": str(row.get("authors") or "").strip()[:120],
            "arxiv_id": arxiv if arxiv and re.fullmatch(r"\d{4}\.\d{4,5}", arxiv) else None,
        }
    return out


def load_store() -> dict:
    if PAPERS_PATH.is_file():
        try:
            store = json.loads(PAPERS_PATH.read_text(encoding="utf-8"))
            if store.get("version") == CACHE_VERSION:
                return store
        except json.JSONDecodeError:
            pass
    return {"version": CACHE_VERSION, "model": DEFAULT_MODEL, "generated_at": None, "entries": {}}


def save_store(store: dict) -> None:
    paths.assert_writable(PAPERS_PATH)
    store["generated_at"] = datetime.now(CST).isoformat(timespec="seconds")
    PAPERS_PATH.write_text(json.dumps(store, ensure_ascii=False, indent=1), encoding="utf-8")


def extract(
    entries: list[dict],
    *,
    api_key: str,
    model: str = DEFAULT_MODEL,
    force: bool = False,
    batch_size: int = BATCH_SIZE,
    concurrency: int = CONCURRENCY,
) -> tuple[dict, dict]:
    store = load_store()
    store["model"] = model
    cache: dict[str, dict] = store["entries"]

    pending = [e for e in entries if force or cache.get(e["id"], {}).get("hash") != _entry_hash(e)]
    stats = {"total": len(entries), "reused": len(entries) - len(pending), "extracted": 0, "failed": 0}
    if not pending:
        return store, stats

    batches = [pending[i : i + batch_size] for i in range(0, len(pending), batch_size)]
    print(f"[论文抽取] 待处理 {len(pending)} 条 → {len(batches)} 批（并发 {concurrency}）", flush=True)

    def run_batch(batch: list[dict]):
        items = "\n\n".join(_item_text(i, e) for i, e in enumerate(batch))
        last_error = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                parsed = parse_response(call_llm(items, api_key, model))
                if not parsed:
                    raise ValueError("解析结果为空")
                return batch, parsed, None
            except Exception as exc:  # noqa: BLE001
                last_error = f"{type(exc).__name__}: {exc}"
                time.sleep(2 * attempt)
        return batch, None, last_error

    done = 0
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(run_batch, b) for b in batches]
        for future in as_completed(futures):
            batch, parsed, error = future.result()
            done += 1
            if parsed is None:
                stats["failed"] += len(batch)
                print(f"  [批次 {done}/{len(batches)}] 失败：{error}", flush=True)
                continue
            for index, entry in enumerate(batch):
                row = parsed.get(index, {})
                cache[entry["id"]] = {
                    "hash": _entry_hash(entry),
                    "date": entry["date"],
                    "category": entry["category"],
                    "report_title": entry["report_title"],
                    "summary": entry["summary"],
                    "arxiv_id_hint": entry["arxiv_id_hint"],
                    "title_hint": entry["title_hint"],
                    "is_paper": bool(row.get("is_paper")),
                    "paper_title": row.get("paper_title") or "",
                    "venue": row.get("venue") or "",
                    "year": row.get("year"),
                    "authors": row.get("authors") or "",
                    "arxiv_id": row.get("arxiv_id"),
                }
            stats["extracted"] += len(batch)
            if done % 10 == 0 or done == len(batches):
                print(f"  [批次 {done}/{len(batches)}] 累计 +{stats['extracted']}", flush=True)
            save_store(store)  # 边跑边存，中断可续

    save_store(store)
    return store, stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="从论文推荐板块抽取论文身份信息")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--api-key", default=None)
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--concurrency", type=int, default=CONCURRENCY)
    args = parser.parse_args(argv)

    source = paths.source_dir()
    entries, warnings = parse_paper_entries(source)
    for warning in warnings[:5]:
        print(f"[告警] {warning}")
    print(f"[解析] 论文推荐条目 {len(entries)} 条（含 arXiv ID {sum(1 for e in entries if e['arxiv_id_hint'])}，含《英文标题》 {sum(1 for e in entries if e['title_hint'])}）")
    if args.limit:
        entries = entries[: args.limit]

    api_key = _resolve_api_key(args.api_key)
    started = time.time()
    store, stats = extract(
        entries,
        api_key=api_key,
        model=args.model,
        force=args.force,
        batch_size=args.batch_size,
        concurrency=args.concurrency,
    )
    is_paper = sum(1 for v in store["entries"].values() if v.get("is_paper"))
    with_title = sum(1 for v in store["entries"].values() if v.get("paper_title"))
    print(
        f"[完成] 共 {stats['total']} 条：复用 {stats['reused']}，新抽 {stats['extracted']}，失败 {stats['failed']}，"
        f"耗时 {time.time() - started:.0f}s"
    )
    print(f"[结果] 判定为论文 {is_paper} 条，其中抽到标题 {with_title} 条 → {PAPERS_PATH}")
    return 0 if stats["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
