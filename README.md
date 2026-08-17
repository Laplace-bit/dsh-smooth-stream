# dsh-smooth-stream

[English](README.en.md) | 中文

[![featured on dsh-suite](https://img.shields.io/badge/featured%20on-dsh--suite-4d6bfe)](https://whyihaveyou.github.io/dsh-suite/)

**dsh-smooth-stream** 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的社区插件，给 Web 对话做**丝滑流式渲染**：字跟着模型走、换行滑入、不闪。不是官方发行的一部分。

项目主页：<https://laplace-bit.github.io/dsh-smooth-stream/>

## 效果

左：默认 Web UI。右：dsh-smooth-stream。

![左：未使用插件。右：使用 dsh-smooth-stream。](docs/compare.gif)

## 它做什么

- **揭示跟着模型走。** 助手文本按到达速率出现。突发不会整段倒出来，慢流也不会停住再猛地补上。
- **一直是 Markdown。** 代码、强调等在流式过程中就按格式渲染，没有先出纯文本再换成排版的交接。
- **换行是滑进来的。** 新的一行或正在变高的工具卡片会滑入视野，而不是把整段记录往上顶一格。
- **滚动条归你。** 往上翻看前文时 overlay 会松手。只有回到底部才会继续跟随——点「回到底部」也算。
- **思考仍是内置那一行。** 推理用原来的 disclosure。它是当前流式尾部时展开，思考一结束就收起；箭头仍可手动开关。
- **整轮一起动。** 运行中的工具卡片、模型重试、workflow run 共用同一套跟随，所以滑的是整轮回复，不只是助手正文。
- **该停的时候会停。** `prefers-reduced-motion` 会直接给出全文，也不接管跟随。帧率低于 30 fps 且回复在屏外时，揭示会暂停，画面恢复后再补上。

## 安装

在 DeepSeek Harness 源码仓库里：

```sh
pnpm dsh plugin --profile web add dsh-smooth-stream
```

如果 `PATH` 上已经有 `dsh`：

```sh
dsh plugin --profile web add dsh-smooth-stream
```

npm 包带预构建的 `lib/`，无需 pnpm ≥10 的构建脚本授权，直接可装。

启动界面：

```sh
pnpm dsh web
```

Host 日志里应出现 `[dsh-smooth-stream] plugin loaded!`。

卸载：`pnpm dsh plugin --profile web remove dsh-smooth-stream`（或 `dsh plugin --profile web remove dsh-smooth-stream`）。

## 配置

组合包默认 `preset: balanced`。要换节拍，在 profile 的 `cordis.patch.yml` 里改：

| `preset` | 手感 |
| --- | --- |
| `realtime` | 更贴模型到达 |
| `balanced` | 默认 |
| `silky` | 缓冲更大，追上更慢 |

`maxScrollSpeedPxPerSec`（默认 `1000`）是速度上限，避免第一次滞后过大时瞬移。

## 用户设置

在 Web 界面打开 **设置 → 插件 → 插件配置**，会看到一张 **丝滑流式（Smooth stream）** 卡片，可切换**「自动展开思考」**：

- **开**（默认）：思考块在流式时自动展开，思考结束收起——与插件默认行为一致。
- **关**：思考块保持折叠；仍可手动点开，且不会被流式状态抢回控制。

该设置是用户级的持久化偏好，改完即生效，无需重启；会写进 DeepSeek Harness 的用户设置文档，而不是插件的组合配置。

## 关于与更新

- **版本 / 主页 / 许可证**：见本页顶部与 [package.json](package.json) 的 `version`、`homepage`、`repository`、`license` 字段；安装的插件列表可在 **设置 → 插件 → 全部** 里查看。
- **更新**：卡片会显示 Host 当前加载的版本。只有当前 profile 明确把 `dsh-smooth-stream` 声明为 npm 依赖时，**更新**按钮才会对该 profile 执行固定的包更新，并提示重启 Harness。`link:` 或 `file:` 本地开发安装会显示为开发版本，更新按钮会保持禁用，避免覆盖你的源码目录。

也可以通过命令行更新 npm 安装的 profile：

```sh
dsh plugin --profile web update dsh-smooth-stream
```

（也可用 `dsh plugin --profile web outdated` 查看是否有新版本。）

## 常见问题

**这是 DeepSeek 官方插件吗？**
不是。它是 DeepSeek Harness（`dsh`）Web UI 的社区插件，MIT 协议开源，不属于 DeepSeek 官方发行。

**dsh 插件怎么安装？**
用内置插件命令：在 dsh 源码目录运行 `dsh plugin --profile web add dsh-smooth-stream`（见[安装](#安装)）。

**能用 npm 安装吗？**
能。`dsh-smooth-stream` 已发布到 [npm](https://www.npmjs.com/package/dsh-smooth-stream)，`dsh plugin --profile web add dsh-smooth-stream` 安装的就是预构建的 npm 包。

**支持 `prefers-reduced-motion` 吗？**
支持。系统开启减少动态效果时直接显示完整文本、不接管跟随；帧率低于 30 fps 且回复在屏外时，揭示自动暂停、恢复后再补上。

## 许可证

[MIT](LICENSE)
