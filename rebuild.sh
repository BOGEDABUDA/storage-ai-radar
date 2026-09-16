#!/usr/bin/env bash
# 一键重建：只读解析语料 → 派生数据 → 前端构建
#
# 新一期日报产出后，跑这个脚本即可刷新站点数据。
# 语料目录可用 DAILY_REPORT_DIR 覆盖。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "==> 1/3 校验语料未被改动（构建前快照）"
python3 -m pipeline.readonly_guard snapshot

echo "==> 2/3 只读解析语料，生成派生数据"
python3 -m pipeline.build

echo "==> 3/3 校验语料仍未被改动（构建后比对）"
python3 -m pipeline.readonly_guard verify

echo "==> 前端构建"
cd web
pnpm install --frozen-lockfile
pnpm run build

echo
echo "✅ 完成。产物：web/dist（本地预览：cd web && pnpm preview）"
