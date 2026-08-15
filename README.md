# dsh-stream

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web plugin for streaming replies. Community project, not part of the official distribution.

## Preview

Left: default Web UI. Right: dsh-stream.

![Left: without the plugin. Right: with dsh-stream.](docs/compare.gif)

## What it does

- **Reveal tracks the model.** Assistant text appears at a cadence that follows the arrival rate. Fast bursts do not dump a whole paragraph; a slow stream does not sit still and then jump.
- **Markdown stays markdown.** Code, emphasis, and the rest render while the reply is still coming. There is no plain-text tail that later swaps into formatted markdown.
- **Wraps glide in.** A new line or a growing tool card eases into view instead of snapping the transcript up by a line.
- **You keep the scroll.** Scroll up to read earlier text and the overlay lets go. Follow resumes only when you return to the bottom — the to-bottom button counts.
- **Think stays the built-in row.** Reasoning uses the usual disclosure. It opens while thinking is the live tail and closes when thinking ends; the chevron still toggles by hand.
- **The rest of the turn moves with it.** Running tool cards, model retries, and workflow runs share the same follow, so the whole turn slides instead of only the assistant text.
- **It backs off when it should.** `prefers-reduced-motion` shows the finished text at once and does not take follow. If the frame rate drops below 30 fps and the reply is off-screen, reveal pauses and catches up when the view is healthy again.

## Install

From a DeepSeek Harness source checkout:

```sh
pnpm dsh plugin --profile web add github:Laplace-bit/dsh-stream
```

If `dsh` is already on your `PATH`:

```sh
dsh plugin --profile web add github:Laplace-bit/dsh-stream
```

The first `add` is expected to fail. Git install has to run this package's `prepare` script, and pnpm ≥10 blocks that until you allow it. Open `~/.dsh/profiles/web/pnpm-workspace.yaml` and add the snippet pnpm printed. On current pnpm that is:

```yaml
onlyBuiltDependencies:
  - dsh-stream
```

Then run the same `add` again.

Start the UI:

```sh
pnpm dsh web
```

The Host log should include `[dsh-stream] plugin loaded!`.

Remove it with `pnpm dsh plugin --profile web remove dsh-stream` (or `dsh plugin --profile web remove dsh-stream`).

## Configuration

The bundle installs with `preset: balanced`. Change it in the profile `cordis.patch.yml` if you want a different cadence:

| `preset` | Feel |
| --- | --- |
| `realtime` | Keeps closer to the model |
| `balanced` | Default |
| `silky` | More buffer, slower catch-up |

`maxScrollSpeedPxPerSec` (default `1000`) is a ceiling so the first large lag does not teleport.

## License

[MIT](LICENSE)
