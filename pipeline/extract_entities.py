"""实体与指标抽取：用 LLM 从 794 条精选洞察中抽取实体、指标，带可复现的增量缓存。

设计要点：
- 结果存 `pipeline/entities.json`（单文件、随仓库提交），使图谱构建**离线可复现**
- 每条记录带内容 SHA-256：洞察文本变化时自动重新抽取，未变则零成本复用
- 批量请求（默认 15 条/次）：794 条只需 ~53 次调用，并发 4 路
- 温度 0，只输出 JSON；解析失败会重试并记录

用法：
    python3 -m pipeline.extract_entities            # 增量抽取
    python3 -m pipeline.extract_entities --force    # 全量重抽
    python3 -m pipeline.extract_entities --limit 30 # 只抽前 30 条（试跑）
    python3 -m pipeline.extract_entities --dry-run  # 只打印提示词，不调 API
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import paths

CST = timezone(timedelta(hours=8))
ENTITIES_PATH = paths.PROJECT_ROOT / "pipeline" / "entities.json"
CACHE_VERSION = 1
DEFAULT_MODEL = "deepseek-v4-flash"
API_ENDPOINT = "https://api.deepseek.com/v1/chat/completions"
MAX_TOKENS = 131072  # 该模型是推理模型，推理 token 计入配额，不可设小（2026-08-08 事故）
BATCH_SIZE = 15
CONCURRENCY = 4
MAX_RETRIES = 3

ENTITY_TYPES = {"company", "institution", "tech", "product", "paper", "person", "metric"}

SYSTEM_PROMPT = """你是存储与 AI 基础设施领域的技术情报抽取引擎。你的输出必须是严格的 JSON，不含任何解释或 markdown 代码块。"""

USER_TEMPLATE = """下面是若干条「存储 / AI 基础设施」领域的行业洞察条目，每条含编号、分类和正文。

请为每一条抽取实体与量化指标：

【entities】条目中出现的**具体且值得长期追踪**的实体，每条 3-8 个。type 必须是以下之一：
- company：公司/厂商（如 浪潮信息、NVIDIA、铠侠）
- institution：研究机构/高校/实验室（如 中科院、KAIST、信通院）
- tech：技术/架构/协议/方法（如 KV Cache、CXL、存内计算、混合键合）
- product：具体产品或型号（如 DeepSeek V4.1 Flash、HF5000、MTT S5000、Kirin 2026）
- paper：论文/基准/数据集（如 ARC-AGI-3、JaxBench）
- person：人物
规则：
1. 使用业界最通用的规范名称，同一实体在一条内只输出一次
2. 必须具体。禁止输出泛化词：「AI」「大模型」「技术」「存储」「数据中心」「性能」「推理」「算力」「芯片」「系统」等
3. 优先抽取有区分度的名称（厂商、产品型号、专有技术、基准）

【metrics】条目中出现的可量化指标，仅当数值与指标是明确对应关系时才抽取（没有就给空数组）：
- subject：该指标描述的主体，必须使用你在 entities 中抽出的规范名（如「DeepSeek V4.1 Flash」「浪潮信息」）；若确实指行业整体而非特定主体，填「行业」
- label：规范化指标名（如「KV缓存单token占用」「训练步耗时」「单板功耗」）
- value：数值（纯数字，可为小数）
- unit：单位（如 B、倍、毫秒、GB/s、IOPS、W、美元、%）
重要：不同主体的同类指标必须用不同 subject 区分，否则会被错误地合并成一条趋势。

严格按以下格式输出，必须为每一条输入返回一个 results 条目，idx 与输入编号一致，不得跳过：
{"results":[{"idx":0,"entities":[{"name":"KV Cache","type":"tech"}],"metrics":[{"subject":"DeepSeek V4.1 Flash","label":"KV缓存单token占用","value":890,"unit":"B"}]}]}

输入条目：
{items}"""


def _digest_hash(digest: dict) -> str:
    raw = f"{digest['topic']}\x1f{digest['text']}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _item_text(index: int, digest: dict) -> str:
    return f"[{index}] 分类：{digest['category_name']}｜视角：{digest['perspective']}\n标题：{digest['topic']}\n正文：{digest['text']}"


def resolve_api_key(explicit: str | None = None) -> str:
    """取 API key：显式参数 > 环境变量 > 日报工作流脚本（只读复用，不复制到本项目）。"""
    if explicit:
        return explicit
    env = os.environ.get("DEEPSEEK_API_KEY")
    if env:
        return env.strip()
    script = Path("/Users/boding/.openclaw/workspace/Daily Report/summarize_articles.py")
    if script.is_file():
        match = re.search(r'API_KEY\s*=\s*"([^"]+)"', script.read_text(encoding="utf-8", errors="replace"))
        if match:
            return match.group(1)
    raise SystemExit(
        "[错误] 未找到 DeepSeek API key。请设置环境变量 DEEPSEEK_API_KEY，或用 --api-key 传入。"
    )


def call_llm(items: str, api_key: str, model: str, *, dry_run: bool = False) -> str:
    prompt = USER_TEMPLATE.replace("{items}", items)
    if dry_run:
        return prompt
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
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        body = json.load(response)
    return body["choices"][0]["message"]["content"]


def parse_response(raw: str) -> dict[int, dict]:
    """从模型输出里稳健地取出 idx → {entities, metrics}。"""
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
        entities = []
        for entity in row.get("entities") or []:
            name = str(entity.get("name", "")).strip()
            kind = str(entity.get("type", "")).strip().lower()
            if name and kind in ENTITY_TYPES and len(name) <= 60:
                entities.append({"name": name, "type": kind})
        metrics = []
        for metric in row.get("metrics") or []:
            label = str(metric.get("label", "")).strip()
            try:
                value = float(metric.get("value"))
            except (TypeError, ValueError):
                continue
            unit = str(metric.get("unit", "")).strip() or None
            subject = str(metric.get("subject", "")).strip() or "行业"
            if label and len(label) <= 40 and len(subject) <= 60:
                metrics.append({"subject": subject, "label": label, "value": value, "unit": unit})
        out[index] = {"entities": entities, "metrics": metrics}
    return out


def load_store() -> dict:
    if ENTITIES_PATH.is_file():
        try:
            store = json.loads(ENTITIES_PATH.read_text(encoding="utf-8"))
            if store.get("version") == CACHE_VERSION:
                return store
        except json.JSONDecodeError:
            pass
    return {"version": CACHE_VERSION, "model": DEFAULT_MODEL, "generated_at": None, "entries": {}}


def save_store(store: dict) -> None:
    paths.assert_writable(ENTITIES_PATH)
    store["generated_at"] = datetime.now(CST).isoformat(timespec="seconds")
    ENTITIES_PATH.write_text(json.dumps(store, ensure_ascii=False, indent=1), encoding="utf-8")


def extract(
    digests: list[dict],
    *,
    api_key: str,
    model: str = DEFAULT_MODEL,
    force: bool = False,
    batch_size: int = BATCH_SIZE,
    concurrency: int = CONCURRENCY,
) -> tuple[dict, dict]:
    """返回 (store, stats)。只对缺失或内容变化的洞察调用 LLM。"""
    store = load_store()
    store["model"] = model
    entries: dict[str, dict] = store["entries"]

    pending: list[dict] = []
    for digest in digests:
        digest_hash = _digest_hash(digest)
        existing = entries.get(digest["id"])
        if not force and existing and existing.get("hash") == digest_hash:
            continue
        pending.append(digest)

    stats = {"total": len(digests), "reused": len(digests) - len(pending), "extracted": 0, "failed": 0}

    if not pending:
        return store, stats

    batches = [pending[i : i + batch_size] for i in range(0, len(pending), batch_size)]
    print(f"[抽取] 需处理 {len(pending)} 条 → {len(batches)} 批（并发 {concurrency}）", flush=True)

    def run_batch(batch: list[dict]) -> tuple[list[dict], dict[int, dict] | None, str | None]:
        items = "\n\n".join(_item_text(i, d) for i, d in enumerate(batch))
        last_error = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                raw = call_llm(items, api_key, model)
                parsed = parse_response(raw)
                if not parsed:
                    raise ValueError("解析结果为空")
                return batch, parsed, None
            except Exception as exc:  # noqa: BLE001
                last_error = f"{type(exc).__name__}: {exc}"
                time.sleep(2 * attempt)
        return batch, None, last_error

    done = 0
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(run_batch, batch) for batch in batches]
        for future in as_completed(futures):
            batch, parsed, error = future.result()
            done += 1
            if parsed is None:
                stats["failed"] += len(batch)
                print(f"  [批次 {done}/{len(batches)}] 失败：{error}", flush=True)
                continue
            for index, digest in enumerate(batch):
                row = parsed.get(index, {"entities": [], "metrics": []})
                entries[digest["id"]] = {
                    "hash": _digest_hash(digest),
                    "date": digest["date"],
                    "category": digest["category"],
                    "entities": row["entities"],
                    "metrics": row["metrics"],
                }
            stats["extracted"] += len(batch)
            print(f"  [批次 {done}/{len(batches)}] +{len(batch)} 条", flush=True)

    save_store(store)
    return store, stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="从精选洞察中抽取实体与指标")
    parser.add_argument("--force", action="store_true", help="全量重抽，忽略缓存")
    parser.add_argument("--limit", type=int, default=0, help="只处理前 N 条（试跑用）")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--api-key", default=None)
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--dry-run", action="store_true", help="只打印提示词，不调用 API")
    args = parser.parse_args(argv)

    from . import parse_digest

    source = paths.source_dir()
    digests, warnings = parse_digest.parse_all(source)
    for warning in warnings[:5]:
        print(f"[告警] {warning}")
    digests.sort(key=lambda d: (d["date"], d["category"], d["perspective"], d["id"]))
    if args.limit:
        digests = digests[: args.limit]

    if args.dry_run:
        items = "\n\n".join(_item_text(i, d) for i, d in enumerate(digests[:2]))
        print(USER_TEMPLATE.replace("{items}", items))
        return 0

    api_key = resolve_api_key(args.api_key)
    started = time.time()
    store, stats = extract(
        digests, api_key=api_key, model=args.model, force=args.force, batch_size=args.batch_size
    )
    elapsed = time.time() - started
    print(
        f"[完成] 共 {stats['total']} 条：复用 {stats['reused']}，新抽取 {stats['extracted']}，"
        f"失败 {stats['failed']}，耗时 {elapsed:.0f}s → {ENTITIES_PATH}"
    )
    return 0 if stats["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
