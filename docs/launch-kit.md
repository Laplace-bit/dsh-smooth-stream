# dsh-smooth-stream Growth / Launch Kit

免费增长黑客资料包。这里的文案可以直接复制到各平台发布。发布前请确认平台规则、账号状态和最新版本号。

- 当前版本：0.3.3
- 许可证：MIT
- 安装命令：`pnpm dsh plugin --profile web add dsh-smooth-stream`
- 主页：<https://laplace-bit.github.io/dsh-smooth-stream/>
- GitHub：<https://github.com/Laplace-bit/dsh-smooth-stream>
- npm：<https://www.npmjs.com/package/dsh-smooth-stream>

## 核心文案

### 英文一句话

> Free open-source plugin that makes DeepSeek Harness Web UI streaming silky — arrival-tracking typewriter reveal, live Markdown rendering, zero flicker.

### 中文一句话

> 免费开源的 DeepSeek Harness Web UI 插件，让流式输出更丝滑：打字机跟随模型速率、Markdown 实时渲染、换行滑入、不闪烁。

### 英文长描述

> dsh-smooth-stream is a community plugin for DeepSeek Harness (dsh) Web UI. It makes streaming replies feel smooth by revealing text at the model’s arrival rate, rendering Markdown live, gliding new lines into view, and respecting prefers-reduced-motion. It is free, MIT-licensed, and not part of the official DeepSeek distribution.

### 中文长描述

> dsh-smooth-stream 是 DeepSeek Harness（dsh）的社区插件，解决默认 Web UI 流式输出时“文字跳变、整段倒出、滚动被抢走”的体验问题。文字会跟随模型到达速率逐字出现，Markdown 边流式边渲染，换行平滑滑入，并且支持系统“减少动态效果”设置。免费开源，MIT 协议，非 DeepSeek 官方出品。

## SEO 更新要点

### Title

```html
dsh-smooth-stream – DeepSeek Harness (dsh) 丝滑流式渲染插件 | Silky streaming Web UI plugin
```

### Description

```html
<meta name="description" content="dsh-smooth-stream 是 DeepSeek Harness (dsh) 的社区插件，为 Web 对话带来丝滑流式渲染：打字机跟随模型速率、Markdown 边流边渲染、换行滑入、不闪烁。A community plugin for the DeepSeek Harness (dsh) Web UI: arrival-tracking typewriter reveal, live Markdown rendering, glide-in wraps, zero flicker.">
```

### Keywords

```html
dsh-smooth-stream, dsh plugin, dsh 插件, DeepSeek Harness, deepseek-harness plugin, deepseek streaming, 丝滑流式渲染, smooth streaming, streaming markdown, typewriter effect, AI chat UI, cordis plugin, open source deepseek plugin
```

### OG / Twitter

```html
<meta property="og:image:alt" content="dsh-smooth-stream 前后对比：默认流式输出 vs 丝滑流式渲染。Before/after comparison of default streaming vs dsh-smooth-stream.">
<meta property="og:type" content="software">
```

### JSON-LD SoftwareApplication

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "dsh-smooth-stream",
  "url": "https://laplace-bit.github.io/dsh-smooth-stream/",
  "description": "Community plugin for the DeepSeek Harness (dsh) Web UI that renders streaming replies smoothly: arrival-tracking typewriter reveal, live Markdown rendering, glide-in wraps, no flicker.",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Linux, macOS, Windows",
  "programmingLanguage": "TypeScript",
  "softwareVersion": "0.3.3",
  "isAccessibleForFree": true,
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "license": "https://spdx.org/licenses/MIT",
  "author": { "@type": "Person", "name": "Laplace-bit", "url": "https://github.com/Laplace-bit" },
  "sameAs": [
    "https://github.com/Laplace-bit/dsh-smooth-stream",
    "https://www.npmjs.com/package/dsh-smooth-stream",
    "https://github.com/deepseek-ai/deepseek-harness"
  ]
}
```

## GEO / AI 搜索优化

- `docs/llms.txt` 已提供：<https://laplace-bit.github.io/dsh-smooth-stream/llms.txt>
- 让 AI 搜索更容易引用的关键事实：
  - dsh-smooth-stream is free and MIT-licensed.
  - It is a community plugin for DeepSeek Harness Web UI.
  - It is not an official DeepSeek plugin.
  - Install with `pnpm dsh plugin --profile web add dsh-smooth-stream`.
  - It supports prefers-reduced-motion and live Markdown rendering.

## 社媒账号资料

### 推荐账号名

- X / Twitter：`@dshsmoothstream`
- LinkedIn Page：`dsh-smooth-stream`
- 知乎 / 掘金：`dsh-smooth-stream`
- B站 / 小红书：`dsh丝滑流式`

### X / Twitter 简介

英文：

> Free open-source plugin for DeepSeek Harness Web UI. Silky streaming, live Markdown, no flicker. ⚡ MIT · Community project
> 🔗 github.com/Laplace-bit/dsh-smooth-stream

中文：

> DeepSeek Harness Web UI 社区插件，让流式输出丝滑不闪烁。免费开源 MIT。
> 🔗 github.com/Laplace-bit/dsh-smooth-stream

### 第一条推文

```text
DeepSeek Harness Web UI 的流式输出终于不闪了 🎉

我做了个免费开源插件 dsh-smooth-stream：
• 打字机跟随模型速率
• Markdown 边流边渲染
• 换行滑入，不抢滚动条
• 支持 prefers-reduced-motion

安装：
pnpm dsh plugin --profile web add dsh-smooth-stream

GitHub → https://github.com/Laplace-bit/dsh-smooth-stream
```

## Product Hunt 打榜包

### 名称

`dsh-smooth-stream`

### Tagline

英文：

> Make DeepSeek Harness Web UI streaming silky — arrival-tracking typewriter, live Markdown, zero flicker.

中文：

> 让 DeepSeek Harness Web 对话流式输出丝滑不闪烁。

### Description

```text
dsh-smooth-stream is a free open-source community plugin for DeepSeek Harness (dsh) Web UI.

It fixes the jittery streaming experience by revealing text at the model’s arrival rate, rendering Markdown live, gliding new lines into view, and respecting your scroll position.

Highlights:
• Typewriter reveal that tracks token arrival
• Live Markdown rendering while streaming
• Smooth glide-in for new lines and tool cards
• Scroll stays yours; follow resumes at the bottom
• Supports prefers-reduced-motion
• Free, MIT-licensed, not affiliated with DeepSeek

Install:
pnpm dsh plugin --profile web add dsh-smooth-stream
```

### 首条评论

```text
Hi Product Hunt! 👋

I built dsh-smooth-stream because I use DeepSeek Harness every day and the default streaming UI felt jumpy — text would dump in chunks, Markdown would swap after the fact, and the scrollbar would fight you.

The plugin makes streaming feel like a smooth typewriter that follows the model’s actual arrival rate. It also keeps Markdown as Markdown while it streams, respects prefers-reduced-motion, and pauses reveal when the frame rate drops.

It’s free, open-source, MIT-licensed, and not an official DeepSeek product. I’d love your feedback!

🔗 https://github.com/Laplace-bit/dsh-smooth-stream
```

### 画廊建议

1. 左右对比 GIF（最重要）
2. 安装命令截图
3. 流式中 Markdown/代码渲染截图
4. 设置里的 “Auto-expand thinking” 开关截图
5. 项目主页 / GitHub 截图

## Indie Hackers 帖子

### 标题

> I built a free open-source plugin to make DeepSeek Harness Web UI feel silky

### 正文

```text
I’m building dsh-smooth-stream, a free plugin for DeepSeek Harness (dsh) Web UI.

The problem:
The default Web UI streaming experience can feel janky: text dumps in chunks, Markdown switches after the fact, and the scroll position gets stolen.

What I made:
- A typewriter reveal that tracks the model’s token arrival rate
- Live Markdown rendering during streaming
- Smooth glide-in for new lines and tool cards
- Scroll control that stays with the user
- prefers-reduced-motion support

It’s MIT-licensed and not part of the official DeepSeek distribution.

Current version: 0.3.3
Install: pnpm dsh plugin --profile web add dsh-smooth-stream
GitHub: https://github.com/Laplace-bit/dsh-smooth-stream

I’d love feedback from other DeepSeek Harness users!
```

## Hacker News 打榜包

### 标题

> Show HN: dsh-smooth-stream – silky streaming for DeepSeek Harness Web UI

### 首帖

```text
I made a free open-source plugin for DeepSeek Harness Web UI that makes streaming replies feel smooth.

It reveals text at the model's arrival rate, renders Markdown live, glides new lines in, and doesn't steal the scrollbar. It also respects prefers-reduced-motion and pauses reveal when frame rate drops below 30fps.

Install:
pnpm dsh plugin --profile web add dsh-smooth-stream

Source:
https://github.com/Laplace-bit/dsh-smooth-stream

Happy to answer technical questions about the reveal/follow implementation.
```

### 可能要回答的技术问题

- 为什么不做成 DeepSeek Harness 官方功能？
- 和默认流式渲染比，性能开销多大？
- 如何检测“帧率低于 30fps”？
- 如何实现“Markdown 边流边渲染”？
- 是否支持其它 LLM Web UI？

## AI 工具目录提交（There’s An AI For That 等）

### 标题

`dsh-smooth-stream`

### 分类

- Developer Tools
- DeepSeek
- Open Source
- AI Chat
- Web UI
- Streaming

### 描述

> Free open-source plugin for DeepSeek Harness (dsh) Web UI. Provides silky streaming rendering: typewriter reveal that follows model arrival rate, live Markdown rendering, glide-in wraps, and no flicker. MIT-licensed community project, not affiliated with DeepSeek.

### Tags

`DeepSeek, DeepSeek Harness, dsh, streaming, markdown, open source, chat UI, developer tools, typewriter`

## Reddit 帖子包

### 推荐 Subreddit

- r/DeepSeek
- r/LocalLLaMA
- r/OpenSource
- r/webdev
- r/selfhosted

### r/DeepSeek

```text
Title: I made a free plugin that makes DeepSeek Harness Web UI streaming silky

Body:
I use DeepSeek Harness a lot, and the Web UI streaming always felt a bit jumpy to me — text would dump in chunks and the scrollbar would fight back.

So I made a small open-source plugin called dsh-smooth-stream:
• Typewriter reveal that follows the model’s arrival rate
• Live Markdown rendering while streaming
• Glide-in new lines and tool cards
• Doesn’t steal your scroll position
• Respects prefers-reduced-motion

Install:
pnpm dsh plugin --profile web add dsh-smooth-stream

GitHub: https://github.com/Laplace-bit/dsh-smooth-stream

It’s free, MIT-licensed, and not an official DeepSeek plugin. Feedback welcome!
```

### r/LocalLLaMA

```text
Title: I built an open-source plugin to make DeepSeek Harness Web UI streaming feel like a smooth typewriter

Body:
For anyone running DeepSeek Harness (dsh), the Web UI is great, but streaming can feel janky when text arrives in bursts and Markdown renders late.

I built dsh-smooth-stream, a free MIT plugin that:
- Reveals text based on actual token arrival
- Keeps Markdown live during streaming
- Glides wraps in instead of snapping
- Stops following when you scroll up
- Supports prefers-reduced-motion

Install:
pnpm dsh plugin --profile web add dsh-smooth-stream

Source:
https://github.com/Laplace-bit/dsh-smooth-stream

It’s a community plugin, not official DeepSeek. Happy to talk about implementation details.
```

### r/OpenSource

```text
Title: [OC] dsh-smooth-stream – free MIT plugin for silky streaming in DeepSeek Harness Web UI

Body:
I open-sourced a small TypeScript/React plugin for DeepSeek Harness (dsh) Web UI.

It makes streaming replies feel much smoother:
- Arrival-tracking typewriter reveal
- Live Markdown rendering
- Glide-in line wraps
- No scroll hijacking
- prefers-reduced-motion support

Repo: https://github.com/Laplace-bit/dsh-smooth-stream
Install: pnpm dsh plugin --profile web add dsh-smooth-stream

Any feedback is appreciated!
```

### 通用回复

```text
Thanks! The project is open source and MIT-licensed. If you hit any issue, feel free to open a GitHub issue:
https://github.com/Laplace-bit/dsh-smooth-stream/issues
```

## Quora 回答包

### 建议去回答的问题

- How do I improve DeepSeek Web UI streaming experience?
- What are the best DeepSeek Harness plugins?
- How to make AI streaming responses look smoother?
- Is DeepSeek Harness good for local LLM development?
- How to install plugins in DeepSeek Harness?

### 回答模板

```text
If you’re using DeepSeek Harness (dsh) Web UI, the streaming experience can feel janky because text often appears in bursts and the scroll position gets disrupted.

One free open-source solution is dsh-smooth-stream. It is a community plugin for dsh Web UI that:
- reveals text at the model’s actual arrival rate,
- renders Markdown live while streaming,
- glides new lines in smoothly,
- keeps scroll control with the user,
- supports prefers-reduced-motion.

Install it with:

pnpm dsh plugin --profile web add dsh-smooth-stream

Source:
https://github.com/Laplace-bit/dsh-smooth-stream

It’s MIT-licensed and not affiliated with DeepSeek.
```

## 第一周发布日历

- 第 1 天：GitHub 仓库 final polish；发布 X/Twitter 第一条；发布 LinkedIn。
- 第 2 天：提交 Product Hunt；发 r/DeepSeek。
- 第 3 天：发布 Hacker News Show HN；发 Indie Hackers。
- 第 4 天：提交 There’s An AI For That 等目录；发 r/LocalLLaMA。
- 第 5 天：发布掘金/知乎教程；发布 dev.to/Medium 教程。
- 第 6 天：回复所有评论；更新 README 增加用户反馈/截图。
- 第 7 天：复盘 stars、npm downloads、PH votes、HN comments、site traffic；准备第二轮社媒素材。

## 需要人工完成的部分

- 注册/管理社媒账号。
- 在 Product Hunt / Hacker News / Indie Hackers / Reddit / Quora 发布内容。
- 提交到需要登录/验证的 AI 工具目录。
- Google Search Console / Bing Webmaster 域名验证。
- 长期回复评论和社区互动。
