# flowctx-dsh

> **DSH 上下文压缩插件**：用「工程师交接笔记」风格的摘要替换长对话历史，在不损失解题能力的前提下大幅降低 token 消耗。

`flowctx-dsh` 是 `dsh-compaction-basic` 的一个薄封装——**只覆盖摘要提示词**。它把通用的压缩指令替换成结构化的六节工程师交接笔记，保留失败路径、关键标识符和正在进行的工作状态，让压缩后的会话能无缝续跑。

---

## 为什么需要它

DSH 的 `BasicCompactionEngine` 已经解决了"如何压缩"的问题，但默认提示词生成的是通用要点摘要。对于需要追踪失败尝试、工具调用链路和中间状态的 coding agent，这类摘要有几个典型短板：

**1. 遗忘失败路径**

通用摘要倾向于保留"当前方案"，丢弃"试过但行不通的路径"。Agent 压缩后可能重复踩同一个坑，直到再次踩坑再次产生上下文压力，形成恶性循环。

**2. 标识符丢失**

session ID、commit hash、函数名、文件路径、配置键——这些精确标识符在通用摘要里常被改写为描述语。改写后的语言貌似保留了语义，但 agent 尝试复现或引用时会因拼写/路径不对而失败。

**3. 工具噪音积累**

长对话中工具调用的输出会反复出现在历史里。DSH 的 `ToolResultPruner` 处理的是超大单条输出的 head/tail 裁剪；但大量中等大小的历史工具结果仍会累积，稀释后续轮次的有效焦点。在压缩前就用结构化摘要替换这部分，效果优于 pruning。

**4. 上下文放大效应**

每轮新增 token 数量通常远小于历史长度，但 TTFT（首 token 延迟）随历史线性增长。在 provider 没有 KV cache 命中时尤为显著：300k token 历史，冷请求约 27s，有 prefix cache 命中后约 3s（约 8× 差异）。压缩把历史缩短，也间接节省了每轮的等待时间。

---

## DSH 的原生上下文管理

`flowctx-dsh` 建立在 DSH 已有的三道防线之上，理解它们有助于理解本插件的定位。

### 三道防线

```
工具调用返回
    │
    ▼
[第一道] SpillPolicy          超大 tool result → 写磁盘，替换为 head/tail 预览
    │
    ▼
[第二道] ToolResultPruner     超长历史 tool/result 节点 → head+tail 裁剪，中间标记
    │
    ▼
[第三道] BasicCompactionEngine
    │   agent/pre-step：历史 token 超阈值 → LLM 摘要 → 结构化 checkpoint
    │   agent/request-error：CONTEXT_WINDOW_EXCEEDED → prune + 摘要 + 重试
    ▼
LLM 请求
```

三层各自独立，通过 Cordis `Context` 组合，缺少任何一层不影响其他层工作。

### 压缩触发与范围选择

压缩在 `agent/pre-step`（每次 LLM 请求发出前）触发，此时历史已完整稳定。触发阈值和保留比例均按 provider/model 动态计算：

```
thresholdTokens = contextWindow × thresholdRatio   (默认 0.8)
retainTokens    = contextWindow × retainRatio       (默认 0.16)
```

以 256k token 的 DeepSeek 模型为例：超过 204,800 tokens 触发，保留最近约 40,960 tokens 不压缩，头部约 163,840 tokens 被折叠为一条 checkpoint 消息。

压缩范围边界始终对齐工具调用/结果配对边界，确保不在 `tool_call` 和其 `tool_result` 之间切断——违反此约束的历史在任何模型下都无法正确 replay。

### 摘要调用复用 KV cache

摘要请求把被压缩区间的原始消息**逐字重放**为前缀，只在末尾追加摘要指令。这使摘要请求成为主请求历史的真前缀，provider 的 prefix cache 命中 system prompt + tool schemas + 历史消息，只有最后一条指令是新输入。

```
摘要调用 = [system prompt] + [tool schemas] + [被压缩历史（verbatim）] + [摘要指令 ←仅新输入]
                                                      ↑
                                               KV cache 命中范围
```

**本插件替换的正是最后这条摘要指令。** 其余所有机制——压力检测、范围选择、KV cache 重放、事务管理、溢出恢复——原封不动继承自 `BasicCompactionEngine`。

---

## 工程师交接笔记格式

本插件把摘要指令替换为如下六节结构：

```
## TASK / GOAL
## WORKING APPROACHES
## FAILED APPROACHES
## KEY IDENTIFIERS
## FILE ARTIFACTS
## OPEN STATE
```

与通用摘要的核心差异：

| 维度 | 通用摘要 | 工程师交接笔记 |
|---|---|---|
| 失败路径 | 通常丢弃 | **专节保留**（FAILED APPROACHES） |
| 精确标识符 | 改写为描述 | **逐字保留**（KEY IDENTIFIERS） |
| 文件路径 | 可能省略 | **显式列出**（FILE ARTIFACTS） |
| 当前状态 | 混入主体 | **专节提炼**（OPEN STATE） |

若被压缩历史中已存在一条 checkpoint（即之前的交接笔记），本次摘要会自动合并——而不是叠加两层嵌套——保持摘要始终是单层结构。

---

## 摘要模型从哪里来

按优先级依次尝试（与 `dsh-compaction-basic` 相同）：

1. 配置项 `summarizationProvider` + `summarizationModel`（显式指定）
2. `agent.session.requestHeader()?.config`（当前会话最近一次路由的 provider/model）
3. `agent.options.provider` + `agent.options.model`（agent 启动参数）

大多数情况下不需要额外配置——直接复用 agent 正在使用的模型。

---

## 安装

### 加入 profile bundles

```bash
# 1. 克隆并构建
git clone https://github.com/changquanyou/flowctx-dsh
cd flowctx-dsh
npm install
npm run build
```

```json
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "flowctx-dsh": "link:/绝对路径/flowctx-dsh"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "flowctx-dsh"]
    }
  }
}
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: flowctx-dsh
      name: flowctx-dsh
```

```bash
cd ~/.dsh/profiles/web && pnpm install && dsh web
```

### 验证加载

```bash
npx @deepseek-ai/dsh --profile web --dump-config | grep flowctx
```

---

## 配置

所有配置项可选。未配置时行为与 `dsh-compaction-basic` 完全相同，仅摘要风格不同。

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: flowctx-dsh
      name: flowctx-dsh
      config:
        # 可选：指定摘要使用的 provider/model（默认跟随 agent 当前路由）
        summarizationProvider: ''
        summarizationModel: ''

        # 可选：摘要 token 上限（0 = 不限，推荐保持默认以避免推理模型被截断）
        summaryMaxTokens: 0

        # 可选：压缩触发阈值（默认 0.8）
        thresholdRatio: 0.8

        # 可选：保留尾部比例（默认 0.16）
        retainRatio: 0.16
```

完整配置项（`thresholdRatio`、`retainRatio`、`retainTokens`、`maxTokens`、`compactionRetries`、`maxOverflowRetries`、`modelPolicies`、`auto`）继承自 `dsh-compaction-basic`，详见 `src/config.ts`。

---

## 开发

```bash
npm install       # 安装开发依赖
npm run typecheck # 类型检查
npm test          # 运行测试（无需外部凭据）
npm run build     # esbuild → lib/index.js
```

---

## 许可证

[MIT](./LICENSE)
