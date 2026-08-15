# dsh-stream

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的社区插件，不是官方发行的一部分。

overlay 保留内置 `MarkdownText` 渲染器，并按模型到达速率揭示助手文本。仍在增长的 Chat 行——助手回复、工具卡片、重试、workflow run——随对话滑行，而不是跳入。读者向上滚动时保持原位；回到底部后重新跟随。

## 环境

- Node.js `^22.19 || >=24`
- DeepSeek Harness 的 Web profile（`dsh web` / `npx @deepseek-ai/dsh web`）
- `PATH` 上有 `pnpm`（`dsh plugin` 会转发给它）

## 安装

在 DeepSeek Harness 源码仓库里（用这份仓库的 `pnpm dsh` 脚本）：

```sh
pnpm dsh plugin --profile web add github:Laplace-bit/dsh-stream
```

如果已经把 CLI 装到全局（`PATH` 上有 `dsh`）：

```sh
dsh plugin --profile web add github:Laplace-bit/dsh-stream
```

`npx @deepseek-ai/dsh …` 在这里不可靠：npm 会在 scoped 包之后去找名为 `dsh` 的二进制，经常报 `dsh: command not found`。有 checkout 就用 `pnpm dsh`；没有的话用 `pnpm dlx @deepseek-ai/dsh …`。

git 安装拉取的是**源码**。pnpm ≥10 在得到允许之前会拦截包的 `prepare` 脚本，所以**第一次** `add` 会失败，并打印一段授权片段。把 pnpm 打印的那段原样复制进 `~/.dsh/profiles/web/pnpm-workspace.yaml`。当前 pnpm 打印的是：

```yaml
onlyBuiltDependencies:
  - dsh-stream
```

较旧的 pnpm / dsh 提示可能写成 `allowBuilds`：

```yaml
allowBuilds:
  dsh-stream: true
```

用 pnpm 实际打印的那种，然后重新执行同一条 `add`。锁定发行版，避免后续推送悄悄改变运行内容：

```sh
dsh plugin --profile web add github:Laplace-bit/dsh-stream#v0.1.0
```

启动 Web UI（源码仓库里用 `pnpm dsh web`）：

```sh
pnpm dsh web
```

Host 日志里应出现 `[dsh-stream] plugin loaded!`。卸载：`dsh plugin --profile web remove dsh-stream`。

## 配置

Cordis 按导出的 schema 校验 overlay 的 `config`。省略字段使用默认值。非法值会使加载失败。

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `mode` | `typewriter` \| `teleprompter` | `typewriter` | 保留以兼容配置；两种模式都不画光标 |
| `preset` | `realtime` \| `balanced` \| `silky` | `balanced` | 揭示节拍平滑预设 |
| `revealCharsPerSec` | number (5–200) | `80` | 运行时不用；实际揭示跟踪观测到达 |
| `scrollSpeedPxPerSec` | number (1–200) | `48` | 运行时不用；跟随是 smooth-damp，不是巡航速度 |
| `maxScrollSpeedPxPerSec` | number (1–2000) | `1000` | 跟随速度上限，避免首次巨大滞后瞬移 |

安装后可在 profile 的 `cordis.patch.yml` 里覆盖这些值。组合包已经按上表默认值插入该行。

`prefers-reduced-motion` 用户会立刻看到完整文本，overlay 也不接管跟随。帧率低于 30 fps **且**回复在屏外时，揭示提交会被按住，等守卫解除后再冲刷。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

渲染测试通过旁边的 DeepSeek Harness checkout 解析包：

```text
~/work/project/deepseek-harness
~/work/project/dsh-stream
```

`prepare` / `build` 用 tsdown 转译 `src/`，不需要这份 sibling。产物是 `lib/index.js`（Host）和 `lib/client.js`（浏览器 ModuleLoader bundle）。

## 许可证

[MIT](LICENSE)
