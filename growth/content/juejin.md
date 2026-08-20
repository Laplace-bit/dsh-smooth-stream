# 掘金技术文章

Title:

```text
DeepSeek Harness 流式回复如何保持同一条滚动轨迹
```

Suggested tags: `前端`, `React`, `TypeScript`, `开源`

## Article

```markdown
流式回复不是简单地在字符串末尾追加字符。

在一轮真实的 Agent 对话里，文字持续换行，Markdown 标题和列表逐步成形，代码块与表格不断增高，思考过程和工具结果还会插入不同的渲染结构。页面每次增高都会改变底部位置。如果每次变化都重新发起一次平滑滚动，浏览器拿到的是一串彼此独立的动画，而不是一段连续运动。

我在 `dsh-smooth-stream` 里把这个问题拆成了两个循环。

## 揭示循环只关心“显示多少”

模型输出的到达速度并不稳定。小块内容到达时，揭示队列保留较缓的节奏；待显示内容增加后，速度会随积压量上升，并在固定上限处停止加速。

队列每帧保留不足一个字符的浮点余量。这样低速阶段不需要强行每帧显示一个字符，高速阶段也不会因为取整反复丢失进度。

在当前参数下，60Hz 的纯算法决策如下：

| 待显示字符 | 目标速度 | 当前帧揭示 |
| --- | --- | --- |
| 8 | 101.4 chars/s | 1 |
| 32 | 154.7 chars/s | 2 |
| 128 | 456 chars/s | 7 |
| 512 以上 | 600 chars/s | 10 |

这些数字描述的是队列决策，不是模型生成速度，也不是 DOM 性能。

## 跟随循环只关心“页面怎样移动”

内容高度变化后，跟随循环更新目标位置。一个阻尼弹簧保存当前位置和速度，并把状态带到下一帧。文字换行、代码块、表格、思考过程和工具结果虽然来自不同组件，但最终都沿同一条轨迹移动。

主线程偶尔停顿时，物理时间会限制在一个可控区间，不会在下一帧一次性重放全部缺失时间。没有被消化的距离继续留在弹簧里，由后续帧逐步追上。

## 两个循环之间需要反馈

如果揭示一直加速、滚动却跟不上，页面仍然会出现不连贯的节奏。因此跟随器会测量当前可用空间；当视觉滞后逐渐填满这段空间时，揭示倍率会从 `1.0` 平滑降到 `0.55`。滚动追上后，倍率再逐步恢复。

这不是把整轮输出简单限速，而是在内容呈现和页面移动之间建立反馈。

## 为什么微基准不能代表完整体验

仓库里的可复现基准只运行两个纯 TypeScript 函数。在 Apple M5、Node.js v22.22.1 上，预热后的中位数分别是每秒约 4730 万次队列决策和 8930 万次弹簧决策。

这个结果只能说明数学计算不是明显热点。它没有包含：

- React commit；
- Markdown 增量解析；
- style / layout；
- paint / composite；
- 设备温度和降频；
- 网络到达节奏。

因此我不会把它包装成“页面性能提升 X%”。完整结论仍然需要在真实 DeepSeek Harness 会话里录制 Chrome Performance trace，并固定回复内容、Harness 版本、插件版本和设备。

## 复现

```sh
git clone https://github.com/Laplace-bit/dsh-smooth-stream.git
cd dsh-smooth-stream
pnpm install
pnpm benchmark
```

工作原理与原始结果：
https://laplace-bit.github.io/dsh-smooth-stream/how-it-works.html?utm_source=juejin&utm_medium=article&utm_campaign=launch-2026-08&utm_content=stream-motion

项目源码：
https://github.com/Laplace-bit/dsh-smooth-stream

`dsh-smooth-stream` 是独立维护的 MIT 开源项目，不属于 DeepSeek 官方发行。
```
