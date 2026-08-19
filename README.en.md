# dsh-smooth-stream

English | [中文](README.md)

**dsh-smooth-stream** brings fluid streaming rendering and silky scrolling to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) Web UI. Text, Markdown, code blocks, tables, and tool results appear as the reply arrives; as the content grows, the page follows along in one continuous visual rhythm.

Project homepage: <https://laplace-bit.github.io/dsh-smooth-stream/>

## Preview

Left: default Web UI. Right: dsh-smooth-stream.

![Left: without the plugin. Right: with dsh-smooth-stream.](docs/compare.gif)

## Core experience

- **Fluid rendering.** Text appears as it arrives while Markdown structure stays active, keeping headings, lists, code blocks, and tables readable throughout the stream.
- **Silky scrolling.** As the content grows, the page follows along one continuous scroll path and keeps the reader close to the generated output.
- **Consistent transitions.** Line wraps, code blocks, tables, and tool results use the same motion treatment, so text, reasoning, and tools flow together.
- **Adaptive cadence.** Reveal speed responds to arrival rate and pending content, staying measured for slow output and catching up with fast output.

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
No. It is independently maintained, MIT-licensed software for the DeepSeek Harness (`dsh`) Web UI and is not affiliated with DeepSeek.

**How do I install a DeepSeek Harness plugin?**
Use the built-in plugin command: `dsh plugin --profile web add dsh-smooth-stream` from a dsh source checkout (see [Install](#install)).

**Can I install it from npm?**
Yes — `dsh-smooth-stream` is published to [npm](https://www.npmjs.com/package/dsh-smooth-stream). `dsh plugin --profile web add dsh-smooth-stream` installs the prebuilt package.

**Does it respect `prefers-reduced-motion`?**
Yes. With reduced motion enabled the finished text is shown at once and the plugin does not take over follow. If the frame rate drops below 30 fps while the reply is off-screen, reveal pauses and catches up later.

[![featured on dsh-suite](https://img.shields.io/badge/featured%20on-dsh--suite-4d6bfe)](https://whyihaveyou.github.io/dsh-suite/)

## License

[MIT](LICENSE)
