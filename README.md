# flowctx-dsh

如果你经常让 AI Agent 处理复杂代码任务，大概率遇到过这种情况：

刚开始，它能记住需求、文件结构、排查路径、失败尝试和测试结果；聊到后面，上下文越来越长，工具输出越来越多，它突然开始重复搜索、忘记约束、重走已经排除的路线。

这不是简单的"模型不聪明"。很多时候，是上下文窗口管理出了问题。

### DSH 已有三道防线

DeepSeek Harness 已经内置了一套三层递进的上下文管理机制：

![DeepSeek Harness 上下文管理架构](docs/assets/deepseek-harness-context-arch.png)

这三层已经能处理大多数场景。但在高强度的 coding agent 工作流中，它们各自有一个难以回避的短板：

**Layer 1（ToolResultPruner）中间内容永久丢失**

ToolResultPruner 对历史节点做就地裁剪——保留 head/tail，删除中间部分，且不另行保存原文。一段 8k 字符的工具输出被裁剪后，中间那几千字就彻底消失了。如果关键的错误行、函数定义或路径恰好在中间，无法找回。

**Layer 2（BasicCompaction）摘要丢失逐字原文**

`BasicCompactionEngine` 把历史压缩成结构化 Checkpoint，使用通用的摘要指令。这对"记住做了什么"足够，但对软件工程任务来说不够精确：

- **失败路径**：摘要倾向于保留"成功方向"，已排除的路线容易被一笔带过，导致 agent 后续重走同样的弯路
- **精确标识符**：session ID、commit hash、函数名、文件路径在摘要里常被改写为自然语言描述，agent 引用时因拼写或路径不对而出错
- **工具噪音积累**：大量中等大小的历史工具结果仍会进入摘要，稀释后续轮次的焦点

**Layer 2 压缩同步阻塞当前步骤**

`BasicCompactionEngine` 在 `agent/pre-step` 里同步执行：触发时，当前步骤必须等待摘要 LLM 调用完成才能继续。对于长历史，这意味着每次触发都会在用户等待响应的关键路径上额外插入一次完整的 LLM 请求，造成明显的延迟抖动。而且压缩越晚触发、历史越长，这次阻塞就越贵。

**Layer 2 触发时机被动，无法主动干预**

压缩在 `pre-step` 压力超阈值后才触发，属于被动兜底。没有机制在工具结果刚返回时就做结构化压缩，也没有可逆的引用存储让 agent 在需要时主动取回原文。

---

传统做法往往很粗暴：窗口快满了，就截断早期对话；或者把历史压成一段笼统摘要。问题在于，软件工程任务里的"早期信息"并不一定过时：一个错误日志、一个函数签名、一个失败 patch、一个隐藏约束，都可能是后续修复的关键。

flowctx-dsh 想解决的就是这个问题。

---

## flowctx-dsh 是什么？

flowctx-dsh 是面向 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/harness) 的开源 ContextEngine 插件，定位是本地优先的短期工作记忆与上下文管理层。

它的核心理念很简单：

> 记忆应当渐远，而不是骤断。

它不把上下文看成"装满就截断"的缓冲区，而是把一次 AI 编程会话看成一段有纵深的工作记忆：越近的信息越清晰，越远的信息越凝练，但不真正遗忘。

- 流程演示：[docs/flow-demo-zh.html](https://ayou-claw.github.io/flowctx-dsh/docs/flow-demo-zh.html)

---

## 三档记忆：当前任务原文保留，历史逐级压缩

flowctx-dsh 按照信息和当前任务的距离，把上下文分成三层：

| 记忆层级 | 处理方式   | 目标                                         |
| -------- | ---------- | -------------------------------------------- |
| 当前任务 | 原文保留   | 刚读到的代码、刚运行的测试、最新需求不丢失   |
| 临近历史 | 结构化压缩 | 大段工具输出压缩成可恢复引用                 |
| 更早历史 | 后台摘要   | 折叠成分层交接笔记，保留失败路径和关键标识符 |

最重要的是：当前正在做的事不会被压缩。Agent 刚刚获得的代码片段、错误输出和工具结果会原样进入模型，避免"刚看完就忘"。

而离当前任务更远的内容，会被确定性投影或摘要折叠，既节省 token，又保留可恢复路径。

与 DSH 原生 Layer 2 的同步压缩不同，flowctx-dsh 的分层摘要是**后台 fire-and-forget** 的：`agent/pre-step` 只做一次纯函数规划，真正的摘要 LLM 调用在关键路径之外异步执行，不会阻塞当前步骤；同一会话若在摘要途中再次触发，旧任务会被 generation 计数器 + AbortController 主动取代，避免重复劳动。

---

## 可逆压缩：省 token，但不把原文丢掉

flowctx-dsh 的结构化压缩不是简单删减。它会把原文保存在本地 CompressionStore 中，并在上下文里留下带 hash 的引用标记。需要时，Agent 可以通过 `flowctx_retrieve` 按 hash byte-exact 取回原文。

这意味着：

- 大段日志可以折叠，但需要时能恢复；
- 大文件片段可以压缩，但不会永久消失；
- 失败尝试可以被摘要，但不会完全丢掉路线；
- 宿主 transcript 始终保留未压缩原文；
- 压缩只是 assemble() 阶段的读时投影，而不是破坏真实会话。

对于代码 Agent 来说，这点很关键。工程上下文不是普通聊天记录，很多细节只有在后续调试时才显出价值。

---

## KV-cache 友好：不只是"把 prompt 变短"

长上下文不仅更贵，也可能影响推理效率。flowctx-dsh 关注字节稳定的 KV-cache 前缀：通过确定性压缩、分层折叠和读时投影，尽量让上下文前缀保持稳定，减少反复重写造成的缓存损失。

它在三个目标之间做平衡：

1. 当前任务的原始材料直接可用；
2. 历史材料可压缩、可恢复、可审计；
3. 上下文前缀尽可能稳定，照顾缓存命中。

这也是 flowctx-dsh 和"直接摘要一下历史"的区别：它不是一次性压缩，而是一套面向长会话 Agent 的上下文引擎。

---

## 评测：token 降了，解题能力没掉

### OpenClaw 版评测（已有数据）

以下数据来自 [flowctx（OpenClaw 版）](https://github.com/Ayou-Claw/flowctx) 在 SWE-bench Verified 上的评测结果（确定性挑选 40 题，覆盖 12 个仓库、跨 3 档难度；关键对照是在共享会话场景下开启或关闭 flowctx）：

| 配置                | 解决率 | 平均分 | KV 命中率 | 总 token/题 |
| ------------------- | ------ | ------ | --------- | ----------- |
| flowctx off · 共享 | 68%    | 71.1   | 96.1%     | 288k        |
| flowctx on · 共享  | 68%    | 71.8   | 93.9%     | 127k        |

结论很直接：

> 在解决率保持 68% 的情况下，平均每题 token 从 288k 降到 127k，下降约 56%。

换句话说，flowctx-dsh 的目标不是"压缩后让模型神奇变强"，而是在不明显牺牲任务质量的前提下，让长会话 Agent 更省、更稳、更少重复劳动。

交互式评测图表（OpenClaw 版）：https://ayou-claw.github.io/flowctx/data/bench/flowctx_bench_zh.html

### DSH 版评测（待补充）

DSH 版本的 SWE-bench 评测正在进行中，结果将在此更新。

---

## DSH 原生集成

flowctx-dsh 建立在 DSH 已有的三道防线之上，并在两个 hook 点上扩展它们。下图中标 `[+]` 的部分是 flowctx-dsh 新增的能力：

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
[+] tools/post-execute        flowctx-dsh：超阈值 tool result → 可逆结构化投影，
    │                          原文写入 CompressionStore（内存 + 可选 SQLite），
    │                          上下文里留带 hash 的 marker
    ▼
[第三道] BasicCompactionEngine
    │   agent/pre-step：历史 token 超阈值 → LLM 摘要
    │                                           ↑
    │                              flowctx-dsh 替换此处的摘要提示词
    │                              → 输出工程师交接笔记而非通用摘要
    │
[+] agent/pre-step（另挂一条 hook）
    │   flowctx-dsh：纯函数规划分层 DAG 摘要 → 后台 fire-and-forget drain
    │   （leaf 折叠 + condense 逐级压缩，summary nodes 可选持久化到 SQLite）
    │   → 把 active summary node 作为 placeholder 注入进入 LLM 的消息流
    ▼
LLM 请求

[+] 工具：flowctx_retrieve（按 hash 取回压缩原文，或按 node id 取回某层交接笔记）
          可选 flowctx_scratch_*（模型可编辑的 working memory）
```

flowctx-dsh 不止替换摘要提示词，它做了三件事：

1. **替换第三道的摘要提示词** —— 输出工程师交接笔记而非通用摘要（压力检测、范围选择、KV cache 重放、事务管理、溢出恢复 `agent/request-error` 等机制仍原封不动继承自 `BasicCompactionEngine`）；
2. **在 `tools/post-execute` 新增可逆投影** —— 工具结果一返回就结构化压缩，原文进 CompressionStore，可随时按 hash 取回；
3. **在 `agent/pre-step` 另挂一条分层 DAG 压缩流水线** —— 后台异步执行、不阻塞关键路径，把历史折叠成分层 summary nodes 并注入占位块。

投影、分层摘要、SQLite 持久化默认开启，均可通过配置关闭；关闭全部扩展后，行为等同于换了摘要风格的 `dsh-compaction-basic`。

---

## 工程师交接笔记格式

```
## TASK / GOAL
## WORKING APPROACHES
## FAILED APPROACHES
## KEY IDENTIFIERS
## FILE ARTIFACTS
## OPEN STATE
```

| 维度       | 通用摘要   | 工程师交接笔记                          |
| ---------- | ---------- | --------------------------------------- |
| 失败路径   | 通常丢弃   | **专节保留**（FAILED APPROACHES） |
| 精确标识符 | 改写为描述 | **逐字保留**（KEY IDENTIFIERS）   |
| 文件路径   | 可能省略   | **显式列出**（FILE ARTIFACTS）    |
| 当前状态   | 混入主体   | **专节提炼**（OPEN STATE）        |

若被压缩历史中已存在一条 checkpoint，本次摘要会自动合并，保持摘要始终是单层结构。

---

## 安装

### 使用 dsh plugin 命令（推荐）

```bash
# 安装到 web profile（headless/tui 同理，换 --profile 参数即可）
dsh plugin --profile web add flowctx-dsh
```

安装完成后，将插件加入 profile 的 patch 层：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: flowctx-dsh
      name: flowctx-dsh
```

然后重启 DSH：

```bash
dsh web
```

### 本地开发版安装

```bash
# 1. 克隆并构建
git clone https://github.com/changquanyou/flowctx-dsh
cd flowctx-dsh && npm install && npm run build

# 2. 链接到 profile
dsh plugin --profile web add /绝对路径/flowctx-dsh
```

之后同样编辑 `cordis.patch.yml` 加入上述 `insert:` 块。

### 验证加载

```bash
dsh --profile web --dump-config | grep flowctx
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

        # 可选：摘要 token 上限（0 = 不限）
        summaryMaxTokens: 0

        # 可选：压缩触发阈值（默认 0.8）
        thresholdRatio: 0.8

        # 可选：保留尾部比例（默认 0.16）
        retainRatio: 0.16

        # 可选：SQLite 持久化目录。设置后，压缩引用、summary nodes
        # 与工作记忆 scratchpad 都会落盘到 <stateDir>/flowctx.sqlite，
        # 三者共用一个数据库句柄，进程重启后可恢复。
        # 不设置则退化为纯内存 + TTL（会话内可恢复）。
        stateDir: ~/.dsh/profiles/web/flowctx-state
```

完整配置项继承自 `dsh-compaction-basic`，详见 `src/config.ts`。

---

## 本地优先、可审计、可恢复

flowctx-dsh 的设计对开发者友好：

- 压缩引用存储在本地 CompressionStore（内存 + TTL 热缓存）；配置 `stateDir` 后，压缩引用与分层 summary nodes 一并持久化到 `<stateDir>/flowctx.sqlite`，进程重启后可恢复（内存未命中时回落到 SQLite 并回填热缓存）；
- 单一 SQLite 句柄跨 refs / summary-nodes 命名空间共享，避免同一文件多句柄的并发写风险；
- 不改写宿主 transcript；
- 摘要是加性的 `<flowctx-handoff-note>`；
- 分层摘要在后台 fire-and-forget 执行，不阻塞 `agent/pre-step` 关键路径；
- `BasicCompactionEngine` 的完整兜底逻辑保留；
- `flowctx_retrieve` 工具让 Agent 可以主动按 hash 取回被压缩的原文，或按 node id 取回某层交接笔记（重启后从 SQLite 读取）。

如果你在做 Agent 基础设施，这些细节很重要：它不是一个黑盒记忆插件，而是一套可检查、可调参、可恢复的上下文管理层。

---

## 适合谁？

flowctx-dsh 适合这些开发者和团队：

- 正在使用 DSH 构建 AI 编程 Agent；
- 经常跑长会话、多文件、多阶段代码任务；
- 工具输出很多，prompt token 持续膨胀；
- 不想用"一刀切截断"牺牲工程上下文；
- 需要本地优先、可审计、可恢复的上下文机制；
- 想研究 Agent 工作记忆、上下文压缩、KV-cache 友好投影。

---

## 开发

```bash
npm install       # 安装开发依赖
npm run typecheck # 类型检查
npm test          # 运行测试（无需外部凭据）
npm run build     # esbuild → lib/index.js
```

---

## 写在最后

AI Agent 的能力，不只取决于模型本身，也取决于它如何管理自己的工作记忆。

flowctx-dsh 给 DSH 提供了一种更工程化的答案：当前任务保持清晰，临近历史结构化压缩，更早历史形成交接笔记，所有关键材料仍可恢复。

如果你也在关注 AI 编程 Agent 的长上下文问题，欢迎查看、试用或 star：

- DSH 版：https://github.com/Ayou-Claw/flowctx-dsh
- OpenClaw 原版：https://github.com/Ayou-Claw/flowctx

---

## 许可证

[MIT](./LICENSE)
