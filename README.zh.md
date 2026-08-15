# dsh-stream

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的社区插件，不是官方发行的一部分。

overlay 保留内置 `MarkdownText` 渲染器，并按模型到达速率揭示助手文本。仍在增长的 Chat 行——助手回复、工具卡片、重试、workflow run——随对话滑行，而不是跳入。读者向上滚动时保持原位；回到底部后重新跟随。

## 安装

需要 DeepSeek Harness 的 Web profile（`dsh web` / `dsh --profile web`）。

```sh
dsh plugin --profile web add github:Laplace-bit/dsh-stream
```

git 安装拉取的是源码。pnpm ≥10 在得到允许之前会拦截包的 `prepare` 脚本。第一次 `add` 会失败并打印键名；把它复制进 `~/.dsh/profiles/web/pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-stream: true
```

然后重新执行 `add`。不想让后续推送悄悄改变运行内容时，请锁定 commit：

```sh
dsh plugin --profile web add github:Laplace-bit/dsh-stream#<sha>
```

启动 Web UI：

```sh
dsh --profile web
```

卸载：`dsh plugin --profile web remove dsh-stream`。

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
