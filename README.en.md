# dsh-smooth-stream

English | [中文](README.md)

[![featured on dsh-suite](https://img.shields.io/badge/featured%20on-dsh--suite-4d6bfe)](https://whyihaveyou.github.io/dsh-suite/)

**dsh-smooth-stream** is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) community plugin for **silky streaming** in the Web UI: arrival-tracking typewriter reveal, glide-in wraps, no flicker. It is not part of the official DeepSeek distribution.

Project homepage: <https://laplace-bit.github.io/dsh-smooth-stream/>

## Preview

Left: default Web UI. Right: dsh-smooth-stream.

![Left: without the plugin. Right: with dsh-smooth-stream.](docs/compare.gif)

## Current behavior

- **The whole Agent turn uses one extensible pipeline.** Assistant text, Think, Context, Retry, Command, Bash, Glob, Read, tool calls, and newly registered renderers all enter progressive reveal and bottom-follow through the same boundary, without a tool-name allowlist.
- **Reveal speed adapts to queue pressure.** Small updates keep a soft cadence while large or fast bursts catch up promptly. Once the producer completes, remaining source is committed immediately instead of continuing to type long after the Agent has stopped.
- **Markdown remains mounted throughout streaming.** Code blocks, tables, emphasis, and other formatting do not begin as plain text and later swap trees. Historical messages also do not replay their reveal animation when remounted.
- **Scroll room opens only when a wrap is actually likely.** The predictor combines buffered source with the current line's remaining width before opening its runway. Long replies still absorb line wraps smoothly, while a short same-line answer after Think does not pre-scroll and rebound.
- **Conversation chrome stays fixed.** `Deep diving...`, the composer, and the to-bottom button never ride the message transform. Fast output and low-frame-rate catch-up cannot paint through the status row or disappear behind the composer.
- **One continuous spring owns motion.** The engine carries velocity and displacement between frames instead of repeatedly starting native smooth-scroll calls. Line wraps, code, tables, and growing tool rows converge along the same trajectory; completion lands on the natural floor and retires temporary state without a flash or overshoot rebound.
- **Reader input wins immediately.** A small upward wheel, touch, or keyboard gesture releases automatic follow. Ownership returns only after the reader actually reaches the bottom again.
- **Think respects the user's preference.** With auto-expand enabled it keeps the Harness disclosure interaction and collapses when thinking ends. With it disabled, collapsed reasoning can keep updating without fake height motion, and a manual toggle is not wrestled back by stream state.
- **Performance guards preserve the final position.** `prefers-reduced-motion` shows complete content without taking follow. Off-screen DOM commits pause under low FPS, then catch up under control and still finish exactly at the bottom.

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

In the Web UI, open **Settings → Plugins → Plugin configuration** to find a **Smooth stream** card with an **"Auto-expand thinking"** toggle:

- **On** (default): reasoning blocks auto-expand while streaming and collapse when thinking ends — the plugin's default behavior.
- **Off**: reasoning blocks stay collapsed; you can still open one by hand, and the stream state will not wrestle it back.

This is a durable, user-level preference that applies live without a restart, and is written to the DeepSeek Harness user-settings document rather than the plugin's composed configuration.

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
No. It is a community plugin for the DeepSeek Harness (`dsh`) Web UI, MIT-licensed, and not part of the official DeepSeek distribution.

**How do I install a DeepSeek Harness plugin?**
Use the built-in plugin command: `dsh plugin --profile web add dsh-smooth-stream` from a dsh source checkout (see [Install](#install)).

**Can I install it from npm?**
Yes — `dsh-smooth-stream` is published to [npm](https://www.npmjs.com/package/dsh-smooth-stream). `dsh plugin --profile web add dsh-smooth-stream` installs the prebuilt package.

**Does it respect `prefers-reduced-motion`?**
Yes. With reduced motion enabled the finished text is shown at once and the plugin does not take over follow. If the frame rate drops below 30 fps while the reply is off-screen, reveal pauses and catches up later.

## License

[MIT](LICENSE)
