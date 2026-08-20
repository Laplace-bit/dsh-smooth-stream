# Reddit: r/DeepSeek

Rules checked on 2026-08-20:

- Must be relevant to DeepSeek or LLMs and provide clear context.
- Self-promotion should stay under the community's 1/10 guideline.
- Project posts should explain value and use cases in a text post, link the
  direct source, avoid promotional titles, and use Resource rather than News.

Do not publish until the account's recent activity satisfies the 1/10 rule.

## Post

Flair: `Resource`

Title:

```text
How I made streaming replies move as one continuous path in DeepSeek Harness
```

Body:

```text
I use the DeepSeek Harness Web UI for long coding replies, where the output is not only text: Markdown wraps, code blocks grow, tables take shape, reasoning expands, and tool results arrive between them.

I wanted those height changes to feel like one continuous reply, so I built an MIT-licensed Web UI plugin called dsh-smooth-stream.

The implementation has two parts:

- an adaptive reveal queue that speeds up when pending content grows;
- one damped spring that carries scroll position and velocity between frames.

The two parts share pressure. When the visible lag approaches the measured room before the status/composer area, the reveal rate eases back until the spring catches up. Markdown stays mounted during the stream, so headings, lists, code blocks, and tables remain in their real rendered structure.

I also added a reproducible algorithm benchmark and wrote down its limits. It measures the queue and spring decisions, not React/layout/paint, so I am not using it to claim the whole UI is “X% faster”:

https://laplace-bit.github.io/dsh-smooth-stream/how-it-works.html?utm_source=reddit&utm_medium=community&utm_campaign=launch-2026-08&utm_content=deepseek-technical

Install:

pnpm dsh plugin --profile web add dsh-smooth-stream

Source:
https://github.com/Laplace-bit/dsh-smooth-stream

I maintain the project and am not affiliated with DeepSeek. I would be interested in traces from people using Harness on lower-power laptops, tablets, or remote mobile browsers, because those are more useful than another desktop-only microbenchmark.
```

## r/LocalLLaMA decision

Do not post this generated draft to r/LocalLLaMA. Its current Rule 3 says
completely or primarily LLM-generated copy is not allowed. A user may write an
original post in their own words later, disclose affiliation, and follow its
1/10 self-promotion guideline.
