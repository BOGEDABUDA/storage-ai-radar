"""路径解析：数据源（只读）与构建产物位置。

核心不变量：**任何写入都不得落在数据源目录内**。
`assert_writable()` 是唯一的写入门禁，所有产物写入前都必须经过它。
"""

from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# 默认数据源；可用 DAILY_REPORT_DIR 覆盖（便于测试）
DEFAULT_SOURCE = "/Users/boding/.openclaw/workspace/Daily Report"

# 产物根目录；可用 RADAR_DATA_DIR 覆盖（便于测试时写入临时目录）
# 放在 web/public/ 下，Vite 会原样拷贝到 dist/，前端按 BASE_URL + "data/..." 取用
WEB_DATA_DIR = Path(
    os.environ.get("RADAR_DATA_DIR", str(PROJECT_ROOT / "web" / "public" / "data"))
)
ARTICLES_DATA_DIR = WEB_DATA_DIR / "articles"

# 构建报告留在 pipeline/ 下且不发布（含本机绝对路径，仅用于本地排障）
BUILD_REPORT_PATH = Path(
    os.environ.get("RADAR_BUILD_REPORT", str(PROJECT_ROOT / "pipeline" / "build_report.json"))
)
CACHE_DIR = Path(os.environ.get("RADAR_CACHE_DIR", str(PROJECT_ROOT / "pipeline" / "cache")))


def source_dir() -> Path:
    """返回只读数据源目录（绝对路径）。"""
    raw = os.environ.get("DAILY_REPORT_DIR", DEFAULT_SOURCE)
    path = Path(raw).expanduser()
    if not path.is_dir():
        raise SystemExit(f"[错误] 数据源目录不存在: {path}")
    return path.resolve()


def ensure_output_dirs() -> None:
    """创建构建产物目录。"""
    ARTICLES_DATA_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    BUILD_REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)


def assert_writable(path: Path) -> Path:
    """写入门禁：拒绝任何落在只读数据源内的写入。"""
    resolved = path.resolve()
    source = source_dir()
    if resolved == source or source in resolved.parents:
        raise SystemExit(f"[拒绝写入] 目标位于只读数据源内，已阻止: {resolved}")
    return resolved
