# dsh-smooth-stream 发布与传播资料包 (Launch & Growth Kit)

> 去除 AI 模板套话与夸张噱头，以扎实的机械力学、物理积分与工程细节打动开发者。

- 当前版本：0.4.1
- 许可证：MIT
- 安装命令：`pnpm dsh plugin --profile web add dsh-smooth-stream`
- 项目主页：<https://laplace-bit.github.io/dsh-smooth-stream/>
- 源码仓库：<https://github.com/Laplace-bit/dsh-smooth-stream>

---

## 核心定位与主张

### 英文一句话 (One-liner)
> Physics-based stream rendering and zero-reflow viewport tracking for the DeepSeek Harness Web UI.

### 中文一句话
> 模型生成是离散的脉冲，而阅读应当是连续的流动：专为 DeepSeek Harness 打造的二阶弹簧视口追踪与物理级流式渲染引擎。

### 英文电梯演讲 (Elevator Pitch)
> LLM output arrives in bursty chunks that cause visual jumps and severe layout thrashing in standard chat UIs. `dsh-smooth-stream` decouples text reveal pacing from viewport motion. By combining fractional character debt integration with a second-order damped spring on the GPU compositor, it turns discontinuous token bursts into a calm, continuous stream with zero reflow during follow.

### 中文核心简介
> 大模型通过 SSE 产生的是离散突发的分块输出。传统 Web UI 将内容渲染与滚动硬绑定在网络事件上，容易引发视觉撕裂与频繁重排。`dsh-smooth-stream` 将节奏展开与视口追踪解耦为两个动力学状态机，利用分数字符积分与二阶阻尼弹簧（GPU 合成层 Transform），将断续的 Token 脉冲转化为连贯的阅读体验，全程零重排跟随。

---

## 开发者社区发布文案 (Developer Communities)

### 1. Hacker News (Show HN)

**Title:** Show HN: dsh-smooth-stream – Physics-based stream renderer for DeepSeek Harness Web UI

**Post:**
```text
Hi HN,

Most AI chat interfaces handle streaming by brute-force appending incoming chunks to the DOM and resetting `scrollTop` to the bottom on every network tick. When large token bursts, code blocks, or line wraps arrive, this causes abrupt visual jumps, broken easing animations, and continuous layout reflows.

I built dsh-smooth-stream, an open-source (MIT) plugin for DeepSeek Harness (dsh) that treats streaming text and scrolling as continuous dynamical systems:

1. Dynamic Pacing Engine: Uses a fractional character debt accumulator to pace text reveal based on backlog queue depth (v = 90 + backlog^1.25 * P). Single-frame visual shift during wraps is capped at <=8px.
2. 2nd-Order Spring Follower: Uses a sub-stepped damped spring (k=130, c=24, m=1). The real scroll container stays pinned at the bottom while residual visual lag is absorbed by a GPU compositor transform, achieving true zero-reflow tracking.
3. Closed-Loop Backpressure: When visual lag fills the 72px runway, reveal pacing dynamically slows down to prevent text from outpacing the viewport spring.
4. Refresh-Rate Parity: Time integration is clamped during main-thread hiccups (dt <= 32ms), producing identical settling dynamics on 60Hz and 120Hz (ProMotion) screens.

Install:
pnpm dsh plugin --profile web add dsh-smooth-stream

GitHub: https://github.com/Laplace-bit/dsh-smooth-stream
Deep dive & benchmarks: https://laplace-bit.github.io/dsh-smooth-stream/how-it-works.html

Would love to hear your feedback on the physics model and browser compositor integration!
```

---

### 2. X / Twitter 线程 (Thread)

**Tweet 1 (Hook & Demo):**
```text
LLM output arrives in bursty chunks. Reading it shouldn't feel like a series of visual jolts.

Introducing dsh-smooth-stream: a physics-based stream renderer & zero-reflow viewport follower for DeepSeek Harness.

• Continuous fractional text pacing
• 2nd-order damped spring on GPU compositor
• Zero reflow during follow

[Attach compare.gif]
```

**Tweet 2 (How it works):**
```text
Why traditional chat UIs jitter:
Native smooth scrolling restarts its easing curve on every incoming chunk, leading to sluggish lag. Calling scrollTop=scrollHeight causes layout thrashing.

dsh-smooth-stream decouples text reveal from scrolling:
1. Pacing engine controls character flow
2. Spring engine drives GPU transform
3. Closed-loop backpressure balances both
```

**Tweet 3 (Link & Install):**
```text
Install in DeepSeek Harness:
pnpm dsh plugin --profile web add dsh-smooth-stream

📦 Gzip ~4.7 kB | MIT Licensed | 120Hz ProMotion Ready

GitHub: https://github.com/Laplace-bit/dsh-smooth-stream
Architecture notes: https://laplace-bit.github.io/dsh-smooth-stream/how-it-works.html
```

---

### 3. V2EX / 掘金 / 知乎技术讨论帖

**标题：** 大模型流式输出的视觉平滑与零重排跟随实践 —— dsh-smooth-stream 技术解析

**正文要点：**
```text
在大模型 Web UI 中，大家可能经常遇到两个体验痛点：
1. 模型突然吐出一大段代码或长段落时，内容猛然蹦出，视线被迫重新定位；
2. 页面跟随滚动时，由于频繁写入 scrollTop 导致动画不断重置、主线程频繁触发布局重排（Reflow）。

我们针对 DeepSeek Harness Web UI 开源了 dsh-smooth-stream 插件，从渲染物理学的角度重新设计了流式体验：

- 揭示节奏引擎：通过分数字符积压积分动态计算当前帧输出量，将 24~28px 的单帧换行冲击分散至多帧（单帧位移 <=8px）。
- 二阶阻尼弹簧跟随：基于 k=130, c=24 的阻尼弹簧驱动视口，真实滚动条停驻在底部，视口微调完全由 GPU 合成层 transform 吸收，做到跟随阶段零重排。
- 闭环背压反馈：当文字生成过快时动态减速，确保内容始终保持在弹性可视范围内。
- 回合结算收敛：回合结束时自动将思考链与工具调用折叠为极简摘要，保持上下文清爽。

安装方式：
pnpm dsh plugin --profile web add dsh-smooth-stream

源码与架构文档：
https://github.com/Laplace-bit/dsh-smooth-stream
```

---

### 4. Reddit (r/LocalLLaMA & r/webdev)

**Title:** A physics-based approach to LLM stream rendering and zero-reflow scrolling (dsh-smooth-stream)

**Body:**
```text
Hey everyone,

When streaming tokens from local or API-based LLMs, standard chat interfaces often suffer from visual jumping whenever new lines, markdown tables, or code fences land.

I open-sourced dsh-smooth-stream (MIT) for DeepSeek Harness to explore a physics-grounded solution:

- Decoupled Pacing: Converts bursty SSE chunks into a smooth character flow using an adaptive queue accumulator.
- Compositor-only Follow: Uses sub-stepped spring physics (k=130, damping=24) applied purely via CSS transform on the message wrapper. The layout engine is never triggered during viewport follow.
- ProMotion 120Hz / 60Hz wall-clock parity with stall clamping.
- Zero extra dependencies, ~4.7 kB gzipped.

Repo: https://github.com/Laplace-bit/dsh-smooth-stream
Interactive demo & math breakdown: https://laplace-bit.github.io/dsh-smooth-stream/how-it-works.html

Feedback and discussions on browser compositor tricks are very welcome!
```

---

### 5. Product Hunt 打榜文案

- **Product Name**: `dsh-smooth-stream`
- **Tagline**: Physics-based stream rendering & zero-reflow viewport tracking for DeepSeek Harness
- **Pricing**: Free / Open Source (MIT)

**Maker First Comment:**
```text
Hey Product Hunt! 👋

When reading long-form AI generations, abrupt token bursts and jumpy viewport scrolling create subtle yet real cognitive fatigue.

We built dsh-smooth-stream to make reading AI responses feel as continuous and natural as reading a teleprompter:
1. Dynamic character reveal queue that adapts to backlog pressure
2. Second-order spring physics running on the GPU compositor (0 layout reflows)
3. Automatic turn folding for thinking processes & tool invocations

It’s completely open source and takes one command to install in DeepSeek Harness. Would love your feedback!
```

