# flowctx-dsh

> **DeepSeek Harness 的上下文压缩插件**：用「工程师交接笔记」风格的摘要替换长会话历史，在不损失解题能力的前提下大幅降低 token 消耗。

`flowctx-dsh` 是 [flowctx](https://github.com/ayou-claw/flowctx) 的 DSH 移植版。它继承自 `dsh-compaction-basic`，**只覆盖摘要提示词**——把通用压缩指令替换成结构化的六节工程师交接笔记，保留失败路径、关键标识符和正在进行的工作状态，让压缩后的会话能无缝续跑。

## 它做什么

当 DSH 的压缩机制（`dsh-compaction-basic`）判断上下文压力超过阈值时，会调用摘要 API 把旧历史折叠成一条 checkpoint 消息。`flowctx-dsh` 接管这一步，生成如下结构的交接笔记：

```
## TASK / GOAL
## WORKING APPROACHES
## FAILED APPROACHES
## KEY IDENTIFIERS
## FILE ARTIFACTS
## OPEN STATE
```

相比通用的「压缩为要点」，这种格式能让 agent 在压缩后仍然记得「哪条路试过了但不行」，避免重复踩坑。

## 摘要模型从哪里来

按优先级依次尝试（与 `dsh-compaction-basic` 相同）：

1. 配置项 `summarizationProvider` + `summarizationModel`（显式指定）
2. `agent.session.requestHeader()?.config`（当前会话最近一次路由的 provider/model）
3. `agent.options.provider` + `agent.options.model`（agent 启动参数）

实际上大多数情况下不需要配置——直接复用 agent 正在使用的模型。

## 安装

### 方式一：加入 profile bundles（推荐）

1. 构建产物：

```bash
git clone https://github.com/changquanyou/flowctx-dsh
cd flowctx-dsh
npm install
npm run build
```

2. 编辑 `~/.dsh/profiles/web/package.json`，把插件加入依赖和 bundles：

```json
{
  "dependencies": {
    "flowctx-dsh": "file:/绝对路径/flowctx-dsh"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "flowctx-dsh"
      ]
    }
  }
}
```

3. 建立符号链接（如 pnpm add 因权限失败可手动建）：

```bash
ln -sfn /绝对路径/flowctx-dsh \
  "$HOME/.dsh/profiles/web/node_modules/flowctx-dsh"
```

4. 验证插入：

```bash
npx @deepseek-ai/dsh --profile web --dump-config | grep flowctx
```

5. 完全重启 DSH：

```bash
# 停止并重新启动
npx @deepseek-ai/dsh web
```

### 方式二：动态加载（快速验证）

参见 [DSH 插件开发文档](https://github.com/deepseek-ai/deepseek-harness) 中的 `cordis_define` / `cordis_run` 动态插件用法。

## 配置

所有配置项可选，继承自 `dsh-compaction-basic`，仅新增 `summaryMaxTokens`。

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: flowctx-dsh
  config:
    # 可选：指定摘要使用的 provider/model（默认跟随 agent 当前路由）
    summarizationProvider: ''
    summarizationModel: ''

    # 可选：摘要 token 上限，0 = 不限（默认，推荐：避免推理模型被截断）
    summaryMaxTokens: 0

    # 可选：压缩触发阈值（默认 0.8，即上下文占用超过 80% 时触发）
    thresholdRatio: 0.8

    # 可选：保留尾部比例（默认 0.16，即约 16% 的上下文不压缩）
    retainRatio: 0.16
```

完整配置项参见 `src/config.ts` 及 [dsh-compaction-basic 文档](https://github.com/deepseek-ai/deepseek-harness)。

## 开发

```bash
npm install       # 安装开发依赖
npm run typecheck # 类型检查
npm test          # 运行测试（20 个，无需外部凭据）
npm run build     # esbuild 打包 → lib/index.js
```

## 与 flowctx 的关系

| 特性 | flowctx（OpenClaw） | flowctx-dsh（DSH） |
|------|---------------------|---------------------|
| 运行时 | OpenClaw ContextEngine | DeepSeek Harness Cordis 插件 |
| 结构化压缩 | 有（零 LLM，确定性） | 由 dsh-compaction-basic 处理 |
| 摘要风格 | 工程师交接笔记 | 工程师交接笔记（相同） |
| 摘要模型来源 | agent 主模型（不允许覆盖） | session 最近路由 → agent 选项 → 配置 |
| 持久化 | SQLite（flowctx 自管） | DSH session 原生持久化 |

`flowctx-dsh` 刻意保持轻量——只替换一个方法，把基础设施的重活（压力检测、token 计量、surface 替换、重试逻辑）留给 DSH 自身处理。

## 许可证

[MIT](./LICENSE)
