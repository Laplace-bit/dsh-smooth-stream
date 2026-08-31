# dsh-smooth-stream — 丝滑流式渲染引擎

> AI 流式输出不再跳帧。**丝滑流式 · 无级滚动 · 0 重排跟随 · 0 跳变** —— 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）Web UI 打造的流式渲染插件。

[English](README.en.md) | 中文

大模型输出是分块到达的：一个块可能在几毫秒内带来几百个字符，下一个块 200ms 后才来。把渲染直接绑在这条流上，屏幕上的表现就是两种失败——**要么整段文字猛地冒出来，要么每一帧都在重排、页面跟着抖**。dsh-smooth-stream 把「渲染」和「滚动」拆成两个独立的引擎，各自维护一段连续状态、每帧积分一次，再用一个 ref 把它们耦合起来：**没有任何一步是跳变的，一切都在逐帧连续演化**。

项目主页：<https://laplace-bit.github.io/dsh-smooth-stream/>

[安装指南](https://laplace-bit.github.io/dsh-smooth-stream/install.html) · [工作原理与可复现基准](https://laplace-bit.github.io/dsh-smooth-stream/how-it-works.html) · [npm](https://www.npmjs.com/package/dsh-smooth-stream)

## 为什么丝滑：三个「0」

- **0 重排的滚动跟随。** 跟随路径只写 `transform`（合成器合成层）并预置 `will-change`，从不逐帧写 `top/left/width`。布局零参与，滚动补偿不会引发重排风暴——这也正是「越滚越跟手、长回复不抖」的原因。
- **0 跳变的揭示与换行。** 揭示速度按队列积压自适应，慢速输出从容呈现、快速输出及时追上；换行和新块的单帧视觉位移被限幅到 ≤8px（`FOLLOW_PAINT_SHIFT_MAX_STEP_PX`），高速输出同样无跳帧。
- **0 突进的完成收敛。** 回合结束时以固定速度匀速倾倒队列，结尾「不倾泻」、不多抓一帧，正文与思考/工具输出衔接干净。

动画路径全程走合成器（`transform`/`opacity`），不触发主线程逐帧重绘；阅读体验对 `prefers-reduced-motion` 与低帧率（<30 fps）自动让步。

## 无级滚动：位置是「积分」出来的，不是「拨」出来的

在默认实现里，每次内容变高就 `scrollTop` 拨到底——一次硬跳；哪怕用 `scroll-behavior: smooth`，浏览器也会对每次写入重启一次平滑动画，缓动曲线永远跑不完，高速流看起来像卡顿的慢放。dsh-smooth-stream 的解法是**无级（level-free）**：

- **揭示引擎**负责「每帧呈现多少新内容」，用积压压力调节速度，携带跨帧的小数字符债务。
- **跟随引擎**用一个阻尼弹簧（stiffness/damping/mass ≈ **130/24/1**）持有当前高度与现实位移，逐帧积分；换行、代码块、表格、工具结果全都喂进同一条连续轨迹。
- 主线程卡顿后物理时间被 clamp，而不是把错过的一整段间隔在一帧里补完——所以 60Hz 与 120Hz 下收束时间几乎一致，**帧率无关的手感**。

## 效果

左：默认 Web UI。右：dsh-smooth-stream。

![左：未使用插件。右：使用 dsh-smooth-stream。](docs/compare.gif)

## 核心体验

- **流畅渲染。** 文字边到边呈现，Markdown 结构持续更新，标题、列表、代码块和表格在流式过程中保持自然的阅读状态。
- **丝滑滚动。** 内容逐步变高时，页面沿连续的滚动轨迹平稳跟随，视线始终贴着正在生成的内容。
- **统一过渡。** 换行、代码块、表格和工具结果使用一致的过渡方式，正文、思考过程与工具输出衔接自然。
- **自适应节奏。** 渲染速度会根据输出速度和待显示内容调整，让慢速输出从容呈现，快速输出及时跟上。

## 可复现基准

「丝滑」不是形容词，是可以用脚本复现的数值：仓库自带浏览器级审计台架，所有闸门本地可跑（`run-render-audit`、`verify-overflow`、`probe-tailbob`）。发布前全量绿灯：

| 闸门 | 结果 |
| --- | --- |
| 渲染审计 `run-render-audit`（5 种流式场景） | **10/10 clean**，零位移突变、零回归 |
| 溢出闸门 `verify-overflow` | **3/3** 无过滚、无回弹 |
| 尾行平滑 `probe-tailbob` | 单帧位移 ≤30px、7 帧振幅 ≤32px **PASS** |
| 行内代码折行 `probe:overlap` | Issue #13 fixture，静态/揭示/引擎三臂 **PASS** |

核心 ESM 产物 gzip 约 **4.7 kB**。详见[工作原理与基准](https://laplace-bit.github.io/dsh-smooth-stream/how-it-works.html)。

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

在 Web 界面打开 **设置 → 插件 → 插件配置**，会看到一张 **丝滑流式（Smooth stream）** 卡片，其中包含：

- **启用丝滑流式渲染**（默认开启）：开启时由本插件接管回复和工具行的渲染与跟随；关闭后会撤销接管，完整使用 Harness 内置渲染。
- **自动展开思考**：控制思考块在流式期间是否自动展开。主开关关闭时此选项不会生效。
- **完成后自动折叠**（默认开启）：回合处理完成后，把思考过程、工具调用、上下文注入和中间输出折叠为一行「已处理 X秒」摘要，只展示最终回复；点击摘要可随时展开或收起完整工作过程。
- **显示渲染调试面板**（默认关闭）：在聊天页右侧显示实时渲染、帧率和滚动跟随数据，并开放流式揭示与滚动弹簧参数。

「自动展开思考」开启时，思考块会在流式时自动展开、思考结束后收起；关闭后思考块保持折叠，仍可手动点开，且不会被流式状态抢回控制。

「完成后自动折叠」在流式期间不干预——回复实时展开输出；只有回合结束（出现结束标记且全部工作完成）才折叠。该开关独立于「启用丝滑流式渲染」：无论由本插件还是内置渲染器负责对话，折叠都照常工作。纯文本回复（无思考、无工具）不会生成摘要行。其他插件通过自定义工具视图嵌入的内容（如 `dsh-pianist` 的钢琴卡片）不会被折叠——只有渲染为原生工具卡样式的调用才参与折叠。此功能取代外挂的 `dsh-auto-collapse` 插件，二者不要同时安装，否则会互相抢夺同一批 DOM 节点造成文字重叠。

这些设置是用户级的持久化偏好，改完即生效，无需重启；会写进 DeepSeek Harness 的用户设置文档，而不是插件的组合配置。

调试面板中的参数在拖动时实时生效，包括揭示倍率、队列压力、最大揭示速度、弹簧刚度/阻尼/质量、预测 runway、runway 响应时间和最低背压倍率。面板同时显示 FPS、帧耗时、积压字符、实际揭示速度、渲染进度、视觉滞后、滚动速度和可用跟随空间；可随时**保存**当前组合、**放弃**未保存修改、**恢复默认**，或复制当前参数与指标。关闭调试开关后，渲染引擎立即恢复正式默认参数。

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
不是。它是面向 DeepSeek Harness（`dsh`）Web UI 的独立维护项目，采用 MIT 许可证，和 DeepSeek 没有从属关系。

**「0 重排」是字面意思吗？**
指动画路径本身。滚动跟随只写合成层 `transform`，不读写布局属性，因此跟随阶段不会引发重排/重绘风暴；文本揭示仍按字符增量写入（这是产生新内容的唯一必要布局），但揭示节奏被限幅，单帧视觉位移 ≤8px，避免跳帧。

**dsh 插件怎么安装？**
用内置插件命令：在 dsh 源码目录运行 `dsh plugin --profile web add dsh-smooth-stream`（见[安装](#安装)）。

**能用 npm 安装吗？**
能。`dsh-smooth-stream` 已发布到 [npm](https://www.npmjs.com/package/dsh-smooth-stream)，`dsh plugin --profile web add dsh-smooth-stream` 安装的就是预构建的 npm 包。

**支持 `prefers-reduced-motion` 吗？**
支持。系统开启减少动态效果时直接显示完整文本、不接管跟随；帧率低于 30 fps 且回复在屏外时，揭示自动暂停、恢复后再补上。

[![featured on dsh-suite](https://img.shields.io/badge/featured%20on-dsh--suite-4d6bfe)](https://whyihaveyou.github.io/dsh-suite/)

## 许可证

[MIT](LICENSE)
