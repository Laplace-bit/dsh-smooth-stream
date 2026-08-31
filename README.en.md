# dsh-smooth-stream — a silky-smooth streaming renderer

> No more frame jumps in AI streaming output. **Silky streaming · level-free scrolling · 0-reflow follow · 0-jank reveal** — a streaming rendering plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) Web UI.

English | [中文](README.md)

Model output arrives in bursts: one chunk can deliver hundreds of characters within a few milliseconds, the next one 200 ms later. Bind the renderer directly to that stream and you see the two classic failures — **text pops out in whole paragraphs, or every frame relayouts and the page judders**. dsh-smooth-stream splits rendering and scrolling into two engines, each maintains continuous state integrated once per frame, and a single ref couples them: **no step is ever discrete; everything evolves continuously frame by frame**.

Project homepage: <https://laplace-bit.github.io/dsh-smooth-stream/>

[Install guide](https://laplace-bit.github.io/dsh-smooth-stream/install.html) · [How it works & reproducible benchmark](https://laplace-bit.github.io/dsh-smooth-stream/how-it-works.html) · [npm](https://www.npmjs.com/package/dsh-smooth-stream)

## Why it feels smooth: three zeros

- **0-reflow follow.** The follow path writes only `transform` (compositor layer) with `will-change` prepared up front — it never writes `top/left/width` frame by frame. Layout stays out of the loop, so the scroll compensation never triggers a reflow storm. That is why long replies stay smooth and keep following the tail.
- **0-jank reveal and wrap.** Reveal speed adapts to queue pressure — measured for slow output, catching up with fast output — and any single-frame visual displacement from a wrap or new block is capped at **≤8px** (`FOLLOW_PAINT_SHIFT_MAX_STEP_PX`). Even high-speed output never jumps.
- **0-burst completion.** When a turn finishes, the queue drains at one fixed velocity: the ending does not "dump", it does not grab an extra frame, and body / reasoning / tool output hand off cleanly.

The animation path runs entirely on the compositor (`transform`/`opacity`), so the main thread is never repainting every frame; the experience also yields automatically to `prefers-reduced-motion` and low frame rates (<30 fps).

## Level-free scrolling: position is integrated, not snapped

The default approach hammers `scrollTop` to the bottom on every growth event — one hard jump per write; even `scroll-behavior: smooth` restarts its easing curve on every write, so the easing never finishes and a fast stream reads like a stuttering slow-motion. dsh-smooth-stream instead is **level-free**:

- The **reveal engine** decides "how much to reveal this frame" from backlog pressure, carrying fractional character debt between frames.
- The **follow engine** holds the current height and the rendered position in a damped spring (**stiffness/damping/mass ≈ 130/24/1**) integrated every frame; wraps, code blocks, tables, and tool results all feed one continuous trajectory.
- After a long main-thread stall, physical time is clamped instead of replaying the whole missed interval in a single paint — so the settle time is nearly identical on 60 Hz and 120 Hz: **refresh-rate-independent feel**.

## Preview

Left: default Web UI. Right: dsh-smooth-stream.

![Left: without the plugin. Right: with dsh-smooth-stream.](docs/compare.gif)

## Core experience

- **Fluid rendering.** Text appears as it arrives while Markdown structure stays active, keeping headings, lists, code blocks, and tables readable throughout the stream.
- **Silky scrolling.** As the content grows, the page follows one continuous scroll path and keeps the reader close to the generated output.
- **Consistent transitions.** Line wraps, code blocks, tables, and tool results use the same motion treatment, so text, reasoning, and tools flow together.
- **Adaptive cadence.** Reveal speed responds to arrival rate and pending content, staying measured for slow output and catching up with fast output.

## Reproducible benchmark

"Silky" is not a marketing adjective here; it is a number you can reproduce. The repo ships a browser-level audit harness with gates that run locally (`run-render-audit`, `verify-overflow`, `probe-tailbob`). Full green before every release:

| Gate | Result |
| --- | --- |
| Render audit `run-render-audit` (5 streaming scenarios) | **10/10 clean**, zero movement regression |
| Overflow gate `verify-overflow` | **3/3** no over-scroll, no rebound |
| Tail smoothing `probe-tailbob` | single-frame ≤30px, 7-frame amplitude ≤32px **PASS** |
| Inline-code wrap `probe:overlap` | Issue #13 fixture across static/reveal/engine arms **PASS** |

Core ESM output gzip ≈ **4.7 kB**. Details in [How it works & benchmark](https://laplace-bit.github.io/dsh-smooth-stream/how-it-works.html).

## Install

From a DeepSeek Harness source checkout:

```sh
pnpm dsh plugin --profile web add dsh-smooth-stream
```

If `dsh` is already on your `PATH`:

```sh
dsh plugin --profile web add dsh-smooth-stream
```

The npm package ships prebuilt `lib/`, so no pnpm ≥10 build-script allowance is needed.

Start the UI:

```sh
pnpm dsh web
```

The Host log should include `[dsh-smooth-stream] plugin loaded!`.

Remove it with `pnpm dsh plugin --profile web remove dsh-smooth-stream` (or `dsh plugin --profile web remove dsh-smooth-stream`).

## Configuration

The bundle installs with `preset: balanced`. Change it in the profile `cordis.patch.yml` if you want a different cadence:

| `preset` | Feel |
| --- | --- |
| `realtime` | Keeps closer to the model |
| `balanced` | Default |
| `silky` | More buffer, slower catch-up |

Legacy `mode`, `revealCharsPerSec`, `scrollSpeedPxPerSec`, and `maxScrollSpeedPxPerSec` fields are still accepted so existing profiles keep loading; the current adaptive engine uses only `preset` to tune cadence.

## User settings

In the Web UI, open **Settings → Plugins → Plugin configuration** to find a **Smooth stream** card with:

- **Enable smooth streaming** (on by default): lets this plugin own reply and tool-row rendering and follow. Turn it off to return rendering completely to the built-in Harness UI.
- **Auto-expand thinking**: controls whether reasoning opens while it streams. This preference has no effect while the master toggle is off.
- **Collapse finished work** (on by default): once a turn finishes processing, its thinking, tool calls, context injection, and intermediate output fold behind one "Processed" summary row so only the final answer shows. Click the summary any time to expand or re-collapse the full process.
- **Show render diagnostics** (off by default): opens a chat-side panel with live rendering, frame-rate, and scroll-follow measurements, plus controls for reveal and spring behavior.

With "Auto-expand thinking" on, reasoning blocks open while streaming and collapse when thinking ends. With it off, reasoning stays collapsed; you can still open a block by hand, and the stream state will not wrestle it back.

"Collapse finished work" never interferes while a reply streams — output expands live, and folding happens only after the turn settles with all work complete. The switch works independently of "Enable smooth streaming": folding applies whether this plugin or the built-in renderer owns the conversation. Plain replies without thinking or tools get no summary row. Content embedded by other plugins through fully custom tool views (such as `dsh-pianist`'s piano card) is never folded — only calls rendered as native tool cards participate. This feature supersedes the standalone `dsh-auto-collapse` plugin; do not run both at once, or they will fight over the same DOM nodes and overlap text.

These are durable, user-level preferences that apply live without a restart, and are written to the DeepSeek Harness user-settings document rather than the plugin's composed configuration.

Diagnostics controls apply as you move them: reveal multiplier, queue pressure, maximum reveal rate, spring stiffness/damping/mass, predictive runway, runway response time, and minimum backpressure scale. The panel reports FPS, frame time, character backlog, effective reveal rate, progress, visual lag, scroll velocity, and available follow room. You can **Save** a combination, **Discard** unsaved edits, **Restore defaults**, or copy the current tuning and measurements. Turning diagnostics off immediately returns the renderer to its production defaults.

## About & updates

- **Version / homepage / license**: see the top of this page and the `version`, `homepage`, `repository`, and `license` fields in [package.json](package.json). Installed plugins are listed under **Settings → Plugins → All**.
- **Updates**: the card shows the version loaded by the Host. When the active profile declares `dsh-smooth-stream` as an npm dependency, its **Update** button runs the same fixed package update for that profile and then asks you to restart Harness. A `link:` or `file:` development install is shown as a development version and deliberately leaves the button disabled, so it cannot replace your checkout.

You can also update an npm-installed profile from the command line:

```sh
dsh plugin --profile web update dsh-smooth-stream
```

(`dsh plugin --profile web outdated` shows whether a newer version exists.)

## FAQ

**Is this an official DeepSeek plugin?**
No. It is independently maintained, MIT-licensed software for the DeepSeek Harness (`dsh`) Web UI and is not affiliated with DeepSeek.

**Is "0 reflow" literal?**
It refers to the animation path. The follow writes only a compositor `transform` and never reads or writes layout properties, so the follow phase causes no reflow/repaint storm; text reveal still writes character increments (the only layout that new content genuinely needs), but reveal cadence is capped so single-frame visual displacement stays ≤8px with no jumps.

**How do I install a DeepSeek Harness plugin?**
Use the built-in plugin command: `dsh plugin --profile web add dsh-smooth-stream` from a dsh source checkout (see [Install](#install)).

**Can I install it from npm?**
Yes — `dsh-smooth-stream` is published to [npm](https://www.npmjs.com/package/dsh-smooth-stream). `dsh plugin --profile web add dsh-smooth-stream` installs the prebuilt package.

**Does it respect `prefers-reduced-motion`?**
Yes. With reduced motion enabled the finished text is shown at once and the plugin does not take over follow. If the frame rate drops below 30 fps while the reply is off-screen, reveal pauses and catches up later.

[![featured on dsh-suite](https://img.shields.io/badge/featured%20on-dsh--suite-4d6bfe)](https://whyihaveyou.github.io/dsh-suite/)

## License

[MIT](LICENSE)
