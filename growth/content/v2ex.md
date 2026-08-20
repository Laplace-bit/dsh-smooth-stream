# V2EX: 分享创造

Target node: [分享创造](https://www.v2ex.com/go/create), whose stated purpose
is publishing your own latest work.

## Topic

Title:

```text
做了一个 DeepSeek Harness 流式渲染插件，把内容揭示和滚动跟随拆成了两个循环
```

Body:

```markdown
最近在用 DeepSeek Harness 跑比较长的编码任务。回复过程中不只是文字在增加，Markdown 换行、代码块、表格、思考过程和工具结果都会持续改变页面高度。

我做了一个 Web UI 插件 `dsh-smooth-stream`，处理这段流式呈现。核心没有调用模型，也不改回复内容，主要是两个循环：

1. 揭示队列根据待显示内容的积压量调整速度。积压少时按较缓的节奏呈现，积压增大后逐步加速。
2. 页面跟随由一个持续弹簧负责，每帧保留位置和速度。换行、代码块和工具结果的高度变化都会进入同一条滚动轨迹。

两者之间还有一层反馈：当页面能够容纳的视觉滞后快要用满时，揭示速度会暂时降低，等滚动跟上后再恢复。Markdown 在流式过程中一直保持实际渲染结构，不会先显示成另一套临时内容。

我把纯算法基准也放进仓库了。它只测揭示决策和弹簧计算，不包含 React、Markdown 解析、layout 和 paint，所以不能拿来宣传“整个 UI 快了多少”。目前更有价值的结论是：60Hz 和 120Hz 下弹簧的实际收敛时间接近，说明运动节奏主要由时间决定，而不是由刷新帧数决定。

工作原理和复现命令：
https://laplace-bit.github.io/dsh-smooth-stream/how-it-works.html?utm_source=v2ex&utm_medium=community&utm_campaign=launch-2026-08&utm_content=technical-post

安装：

```sh
pnpm dsh plugin --profile web add dsh-smooth-stream
```

源码：
https://github.com/Laplace-bit/dsh-smooth-stream

项目使用 TypeScript / React，MIT 协议。目前更想收集低功耗设备或移动端远程访问 Harness 时的 Performance trace，这比继续堆桌面微基准更能说明真实体验。
```

Do not add a request for stars or replies.
