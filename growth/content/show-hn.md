# Show HN

Research checked on 2026-08-20:

- Show HN accepts things people can run and try without a signup barrier.
- It asks makers to explain how and why, and to remain available for discussion.
- It forbids asking friends to upvote or comment.
- A minor version announcement alone is not enough; this submission is about
  the working project and its motion model, not the v0.3.4 release.

## Submission

Title:

```text
Show HN: dsh-smooth-stream – continuous streaming motion for DeepSeek Harness
```

URL:

```text
https://github.com/Laplace-bit/dsh-smooth-stream
```

## First comment

```text
I built dsh-smooth-stream after using the DeepSeek Harness Web UI for long coding sessions. A streaming reply changes height every time text wraps or a code block, table, reasoning section, or tool result grows. Treating each change as a new smooth-scroll request gives the browser a sequence of separate animations rather than one continuous motion.

The plugin separates the problem into two loops:

1. An adaptive reveal queue decides how much source text to expose. Small queues keep a measured cadence; larger queues raise the reveal rate up to a fixed ceiling.
2. A damped spring owns vertical motion and carries position and velocity between frames. The reveal loop receives backpressure when the safe visual lag fills, so content growth does not outrun the follower.

Markdown remains mounted while the source grows, and the same follow path covers text, reasoning, code blocks, tables, and tool output. The screen-reader live region is paced separately from visual frames and only announces new text.

I added a reproducible microbenchmark for the pure queue and spring decisions:
https://laplace-bit.github.io/dsh-smooth-stream/how-it-works.html?utm_source=hackernews&utm_medium=community&utm_campaign=launch-2026-08&utm_content=show-hn

The benchmark deliberately does not claim end-to-end UI speed. It excludes React, Markdown parsing, layout, paint, device thermals, and network time; those need a real Harness Performance trace. Its useful result is narrower: the queue/spring math is cheap, and the spring settles in nearly the same wall-clock time at 60Hz and 120Hz.

Install:
pnpm dsh plugin --profile web add dsh-smooth-stream

The project is TypeScript/React, MIT licensed, and independently maintained. I would particularly value Performance traces from lower-power devices and feedback on the reveal/follow interaction.
```

## Follow-up discipline

- Answer technical questions with source links or measured data.
- Do not ask for points, stars, or supportive comments.
- If a result cannot be reproduced, say so and update the benchmark.
