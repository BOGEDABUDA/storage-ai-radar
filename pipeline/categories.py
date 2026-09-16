"""分类与 slug 映射。

语料有 10 个固定分类（42 期全部一致，已实测）。本表把中文分类名映射为
URL 友好的稳定 slug。遇到未知分类名时回退为 `cat-<hash>` 并记录告警，
保证未来新增分类不会导致构建失败。
"""

from __future__ import annotations

import hashlib

# (中文名, slug)，顺序即 UI 展示顺序：AI 基础设施 → 存储 → 测评 → 其他
CATEGORIES: list[tuple[str, str]] = [
    ("AI推理加速优化技术", "ai-inference-acceleration"),
    ("AI模型及Agent_RAG等技术", "ai-model-agent-rag"),
    ("近存加速_存内计算", "near-memory-computing"),
    ("新介质", "new-media"),
    ("新存储设备语义_协议", "storage-semantics-protocol"),
    ("大容量存储设备", "high-capacity-storage"),
    ("高可靠性存储", "high-reliability-storage"),
    ("高性价比存储技术", "cost-effective-storage"),
    ("模型性能的测评分析", "model-benchmarking"),
    ("其他", "others"),
]

NAME_TO_SLUG: dict[str, str] = dict(CATEGORIES)
SLUG_TO_NAME: dict[str, str] = {slug: name for name, slug in CATEGORIES}
DISPLAY_ORDER: dict[str, int] = {slug: i for i, (_, slug) in enumerate(CATEGORIES)}

# `其他` 占全部文章约 42%，内容异质，不参与领域热度主榜
CATCH_ALL_SLUG = "others"

_warnings: list[str] = []


def slug_for(name: str) -> str:
    """分类名 → slug。未知分类回退为稳定哈希 slug 并记录告警。"""
    name = name.strip()
    if name in NAME_TO_SLUG:
        return NAME_TO_SLUG[name]
    fallback = "cat-" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]
    msg = f"未知分类 {name!r} → 回退 slug {fallback}"
    if msg not in _warnings:
        _warnings.append(msg)
    return fallback


def sort_key(slug: str) -> tuple[int, str]:
    """按展示顺序排序，未知 slug 排在最后。"""
    return (DISPLAY_ORDER.get(slug, len(CATEGORIES)), slug)


def take_warnings() -> list[str]:
    """取出并清空累积的分类告警。"""
    out = list(_warnings)
    _warnings.clear()
    return out


def is_known(name: str) -> bool:
    return name.strip() in NAME_TO_SLUG
