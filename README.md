# Lab Insight Radar

把 OpenClaw 日报语料（存储 / AI 基础设施，42 期，2026-04-29 → 2026-09-14）变成可浏览、可检索、可看趋势的知识库，并发布到 GitHub Pages。

- **只读**：绝不修改 `Daily Report` 目录下任何内容
- **静态优先**：GitHub Pages 托管派生数据，不含原始语料
- **可降级**：Agent 仅本机运行；未启动时站点自动降级为纯检索模式，功能不受影响

## 文档

- 设计文档：[`docs/superpowers/specs/2026-09-16-lab-insight-radar-design.md`](docs/superpowers/specs/2026-09-16-lab-insight-radar-design.md)

## 分阶段交付

| 阶段 | 内容 | 状态 |
|---|---|---|
| P1 | 解析层 + 数据契约 + 站点核心 + 明暗主题 + 部署上线 | 待实现 |
| P2 | 实体抽取 + 知识图谱 + 趋势跟踪 | 待实现 |
| P3 | Agent 服务（RAG 问答 + 引用）+ 站点侧栏 | 待实现 |

## 目录

```
pipeline/   只读解析语料 → web/data/*.json + insight.sqlite（Python 标准库）
web/        Vite + TypeScript 静态站
agent/      Node 零依赖 Agent 服务（localhost:8787）
tests/      单元测试（含只读断言）
```

## 数据源

`/Users/boding/.openclaw/workspace/Daily Report`（通过 `DAILY_REPORT_DIR` 环境变量可覆盖）
