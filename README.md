# dsh-smooth-stream

[English](README.en.md) | 中文

[![featured on dsh-suite](https://img.shields.io/badge/featured%20on-dsh--suite-4d6bfe)](https://whyihaveyou.github.io/dsh-suite/)

**dsh-smooth-stream** 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的社区插件，给 Web 对话做**丝滑流式渲染**：字跟着模型走、换行滑入、不闪。不是官方发行的一部分。

项目主页：<https://laplace-bit.github.io/dsh-smooth-stream/>

## 效果

左：默认 Web UI。右：dsh-smooth-stream。

![左：未使用插件。右：使用 dsh-smooth-stream。](docs/compare.gif)

## 当前实现

- **整轮 Agent 输出统一接管。** 助手正文、Think、Context、Retry、Command、Bash、Glob、Read、工具调用以及后续注册的新渲染器，都通过同一个可扩展入口进入渐进揭示和底部跟随，不依赖工具名称白名单。
- **吐字速度会跟随积压自动变速。** 小批内容保持柔和节拍，大批或高速到达时及时追赶；完成信号到达后立即提交剩余正文，不让 Agent 已结束而文字还长时间继续输出。
- **流式过程始终使用 Markdown 渲染。** 代码块、表格、强调等不会先显示成纯文本再整体换树，历史消息也不会在重新挂载时重播动画。
- **换行前才准备滚动空间。** 引擎结合待揭示内容和当前行剩余宽度判断是否可能增高，只在真实换行风险出现时打开预测 runway。长回复仍能平滑吸收换行，Think 后的短同一行正文不会多滚再回弹。
- **状态区域保持稳定。** `Deep diving...`、输入框和「滚动到底部」按钮不参与消息 transform；高速输出或低帧率下，正文也不会越过状态区域或藏到输入框后面。
- **滚动使用持续弹簧而不是反复启动原生平滑滚动。** 每帧保留速度和位移状态，换行、代码块、表格及工具卡片增高都沿同一轨迹收敛；结束时落在自然底部并安静撤销临时状态，不闪烁、不越位回弹。
- **用户输入拥有最高优先级。** 向上滚轮、触控拖动或键盘滚动会在轻微手势时立即解除自动跟随；只有用户真正回到底部后才重新接管。
- **Think 尊重用户设置。** 自动展开开启时沿用 Harness 的 disclosure 交互并在思考结束后收起；关闭时折叠内容持续更新但不引发虚假高度和上下闪动，手动展开也不会被流状态抢回。
- **性能保护不会破坏最终状态。** `prefers-reduced-motion` 直接显示完整内容且不接管跟随；低帧率且回复在屏外时暂停 DOM 提交，恢复后受控追赶，最终仍准确停在底部。

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

旧版的 `mode`、`revealCharsPerSec`、`scrollSpeedPxPerSec` 和 `maxScrollSpeedPxPerSec` 字段仍可被加载，以兼容已有 profile；当前自适应引擎仅使用 `preset` 调整节拍。

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
