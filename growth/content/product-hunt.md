# Product Hunt launch package

Prepared on 2026-08-20. The launch is paused until a new product-recorded GIF
or video is available. Do not publish with static gallery images: the product's
main value is motion and cannot be shown accurately in a still image.

## Product fields

Name:

```text
dsh-smooth-stream
```

Tagline:

```text
Fluid streaming for DeepSeek Harness
```

Description:

```text
dsh-smooth-stream adds adaptive streaming reveal and continuous scroll following to the DeepSeek Harness Web UI. Text, Markdown, code blocks, tables, reasoning, and tool results move through one visual rhythm.
```

Website:

```text
https://laplace-bit.github.io/dsh-smooth-stream/?utm_source=producthunt&utm_medium=directory&utm_campaign=launch-2026-08&utm_content=product-page
```

Repository:

```text
https://github.com/Laplace-bit/dsh-smooth-stream
```

Suggested topics:

```text
Open Source
Developer Tools
Productivity
```

Pricing:

```text
Free
```

## Maker comment

```text
I built dsh-smooth-stream for the long replies I read in DeepSeek Harness every day.

A reply can grow through text, Markdown, code blocks, tables, reasoning, and tool results. Each piece changes the page height. The plugin treats that as one continuous motion: an adaptive queue controls how content is revealed, while a damped spring carries the page along the growing reply.

The project is open source under MIT and installs from npm with one command:

pnpm dsh plugin --profile web add dsh-smooth-stream

I also published the algorithm benchmark and its limits. It measures the queue and spring math, not the whole browser UI, so there is no unsupported “X% faster” claim.

I would value feedback from people who use DeepSeek Harness for long coding sessions, particularly on lower-power devices or remote mobile browsers.
```

## Gallery status

Waiting for a newly recorded GIF or video that shows the actual streaming and
scroll motion. Finalize the gallery order only after that asset is available.

Do not substitute static screenshots, decorative AI-generated images, or
unverified user quotes.

## Launch-day comment prompts

Use these only when they answer an actual question:

Installation:

```text
The npm package ships prebuilt output. From a DeepSeek Harness checkout, run:
pnpm dsh plugin --profile web add dsh-smooth-stream

The complete install and update guide is here:
https://laplace-bit.github.io/dsh-smooth-stream/install.html
```

Performance:

```text
The checked-in benchmark measures only the pure queue and spring decisions. It deliberately excludes React, Markdown parsing, layout, and paint. For end-to-end performance I would rather compare shared Chrome traces from fixed fixtures than publish a broad number the benchmark cannot support.
```

Affiliation:

```text
It is independently maintained, MIT-licensed software for the DeepSeek Harness Web UI and is not affiliated with DeepSeek.
```

Never ask for upvotes in private messages or external communities.
