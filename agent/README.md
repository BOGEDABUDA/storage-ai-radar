# Agent 服务（P3）

本机运行的检索增强问答服务，让静态站点具备「点击深挖 + 自由提问」能力。

**零 npm 依赖**：只用 `node:http`、`node:sqlite`、`fetch`。

## 启动

```bash
cd storage-ai-radar

# 1) 构建检索索引（首次，约 6 秒，产出 insight.sqlite ~97 MB，不进仓库）
python3 -m pipeline.build_index

# 2) 配置 API key（可选：不配也能用检索，只是不能问答）
cp agent/.env.example agent/.env && $EDITOR agent/.env

# 3) 启动
node agent/server.mjs
#   → http://127.0.0.1:8787/api/health
```

站点右上角的 **✦ Agent** 按钮会探测 `http://127.0.0.1:8787`；探测不到时面板显示启动指引，
**不影响**图谱、趋势、检索等静态功能。

也可以把问题写进链接直接分享：`#/graph?ask=存内计算和近存加速有什么区别？`

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查，前端据此决定是否启用问答 |
| GET | `/api/search?q=&category=&from=&to=&limit=` | FTS5 检索洞察 + 文章摘要 |
| GET | `/api/entity/:label` | 某实体/关键词的深挖资料 |
| POST | `/api/deep` | 在原始正文里检索（`{q, date?, dates?, limit?}`） |
| POST | `/api/ask` | 基于检索结果流式问答，SSE 事件：`sources` → `delta`* → `done` |

## 检索设计

- **中文分词**：FTS5 `trigram`，无需外部分词器
- **短词兜底**：trigram 对 <3 字符的词用不上索引，自动退化为 `LIKE` 扫描
- **自然语言问句**：先剥离疑问词/停用词并识别「和/与/及/或」连接词
  （`存内计算和近存加速有什么区别？` → `存内计算`、`近存加速`、`区别`）
- **召回与排序**：用 OR 召回 4 倍候选，再按「命中了几个检索词」重排，
  这样不会因为某个词配不上而整体落空，同时覆盖度高的结果排在前面
- **原始正文不入库**：`articles/` 有 353 MB，trigram 索引约为正文的 4~5 倍体积。
  原始正文本来就以只读方式在磁盘上，`/api/deep` 按日期读取对应目录即可，
  既不重复存储，也天然保持「不修改语料」

## 安全

- 默认只绑 `127.0.0.1`，不对外监听
- API key 只从环境变量 / `agent/.env` / 日报脚本（只读）读取，**绝不下发到浏览器**
- CORS 白名单默认只允许 `https://bogedabuda.github.io` 与本地预览端口
  （`http://localhost` 属浏览器安全上下文，因此 HTTPS 站点可以直接调用它）
- 可选 `RADAR_AGENT_TOKEN` 启用 Bearer Token 鉴权

## 测试

```bash
node --test agent/test.mjs
```
