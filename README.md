# Lab Insight Radar · 领域洞察雷达

把 OpenClaw 日报语料（存储 / AI 基础设施，42 期，2026-04-29 → 2026-09-14）变成**可浏览、可检索、可看趋势**的知识库，并发布到 GitHub Pages。

线上地址：https://bogedabuda.github.io/storage-ai-radar/

## 三条硬约束

1. **只读**：绝不修改 `Daily Report` 目录下任何内容 —— 构建前后对 26,680 个文件做 SHA-256 清单比对断言
2. **静态优先**：GitHub Pages 只托管派生数据（约 26 MB，gzip 后约 6 MB），353 MB 原始正文永不发布
3. **可降级**：Agent 仅本机运行；未启动时站点自动降级为纯检索模式，功能不受影响

## 快速开始

```bash
./rebuild.sh          # 快照校验 → 解析语料 → 再校验 → 构建前端
cd web && pnpm preview  # 本地预览 http://localhost:4173/storage-ai-radar/
```

## 分阶段交付

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P1** | 解析层 + 数据契约 + 站点核心（概览/领域/检索/归档）+ 明暗三态主题 + GitHub Pages 部署 | ✅ 已完成 |
| **P2** | 实体抽取（LLM + 哈希缓存）+ 知识图谱 + 趋势跟踪 | 待实现 |
| **P3** | Agent 服务（FTS5 中文 RAG + 流式问答 + 引用）+ 站点侧栏 | 待实现 |

## 语料规模（实测）

| 指标 | 数值 |
|---|---|
| 报告期数 | 42（2026-04-29 → 2026-09-14） |
| 文章摘要 | 15,192 篇 |
| 精选洞察 | 794 条（774 条带视角 + 20 条自由标题） |
| 详细要点 | 798 条（原文引用覆盖 794/794） |
| 研究方向 | 10 个 |

### 两处真实数据稀疏（非解析缺陷）

- 12/42 期存在「分类为 0 篇」（分类文件只有标题行）；最稀疏的 `2026-05-15` 仅 22 篇、覆盖 5 个分类
- 32 篇文章的「总结」在源数据中即为空（多为招聘/汽车等非科技内容）

站点按**真实 0** 呈现，不做插值填补。

## 目录结构

```
pipeline/   只读解析语料（Python 标准库，零 pip 依赖）
  categories.py       分类 ↔ slug 映射
  parse_digest.py     output/*/daily_report.md  → 精选洞察
  parse_articles.py   total/*/*.md             → 文章摘要
  parse_detail.py     output/*/*_详细.md        → 原文来源链接
  build.py            编排入口：python3 -m pipeline.build
  readonly_guard.py   只读保证：快照 / 校验
  paths.py            路径与写入门禁（拒绝写入数据源）
web/        Vite + TypeScript 静态站（零运行时依赖，图表自绘 SVG）
  public/data/        派生数据（随仓库提交，CI 直接用）
  src/search/         全文检索 Web Worker（中文子串匹配 + AND 语义）
agent/      Node 零依赖 Agent 服务（P3）
tests/      unittest（17 项：契约/边界/幂等/只读）
```

## 常用命令

```bash
python3 -m pipeline.build              # 重新生成派生数据
python3 -m pipeline.readonly_guard verify   # 校验语料未被改动
python3 -m unittest discover -s tests -t .  # 跑测试
cd web && pnpm run build               # 前端构建
```

## 数据源

`/Users/boding/.openclaw/workspace/Daily Report`（可用 `DAILY_REPORT_DIR` 环境变量覆盖）

## 配置

前端子路径固定在 `web/vite.config.ts` 的 `base: '/storage-ai-radar/'`，与仓库名一致；改名时两处都要改。

## 文档

- 设计文档：[`docs/superpowers/specs/2026-09-16-lab-insight-radar-design.md`](docs/superpowers/specs/2026-09-16-lab-insight-radar-design.md)
