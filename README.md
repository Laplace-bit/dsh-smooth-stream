# dsh-stream

English | [中文](README.zh.md)

Community plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It is not part of the official distribution.

The overlay keeps the built-in `MarkdownText` renderer and reveals assistant text at a cadence that tracks the model's arrival rate. Growing Chat rows — the assistant reply, tool cards, retries, workflow runs — glide with the conversation instead of jumping. A reader who scrolls away keeps their place; returning to the floor resumes follow.

## Requirements

- Node.js `^22.19 || >=24`
- A DeepSeek Harness Web profile (`dsh web` / `npx @deepseek-ai/dsh web`)
- `pnpm` on `PATH` (`dsh plugin` forwards to it)

## Install

```sh
dsh plugin --profile web add github:Laplace-bit/dsh-stream
```

If `dsh` is not on `PATH`:

```sh
npx @deepseek-ai/dsh plugin --profile web add github:Laplace-bit/dsh-stream
```

A git install fetches **sources**. pnpm ≥10 blocks the package `prepare` script until you allow it, so the **first** `add` fails and prints the allowlist snippet. Copy that exact snippet into `~/.dsh/profiles/web/pnpm-workspace.yaml`. Current pnpm prints:

```yaml
onlyBuiltDependencies:
  - dsh-stream
```

Older pnpm / the dsh hint may say `allowBuilds` instead:

```yaml
allowBuilds:
  dsh-stream: true
```

Use whichever form pnpm printed, then run the same `add` again. Pin a release so a later push cannot change what runs:

```sh
dsh plugin --profile web add github:Laplace-bit/dsh-stream#v0.1.0
```

Start the Web UI:

```sh
dsh web
```

The Host log should include `[dsh-stream] plugin loaded!`. Remove it with `dsh plugin --profile web remove dsh-stream`.

## Configuration

Cordis validates the overlay `config` against the exported schema. Omitted fields use the defaults. An invalid value fails the load.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | `typewriter` \| `teleprompter` | `typewriter` | Kept for config compatibility; neither mode draws a caret |
| `preset` | `realtime` \| `balanced` \| `silky` | `balanced` | Reveal-cadence smoothing preset |
| `revealCharsPerSec` | number (5–200) | `80` | Unused at runtime; live reveal tracks observed arrival |
| `scrollSpeedPxPerSec` | number (1–200) | `48` | Unused at runtime; follow is a smooth-damp, not a cruise speed |
| `maxScrollSpeedPxPerSec` | number (1–2000) | `1000` | Follow velocity ceiling so a huge first lag does not teleport |

Override values in the profile `cordis.patch.yml` after install. The bundle already inserts the row with the defaults above.

`prefers-reduced-motion` users receive the complete text immediately, and the overlay does not take follow. While the frame rate is below 30 fps **and** the reply is offscreen, reveal commits are held back and flush when the guard clears.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

Renderer tests resolve DeepSeek Harness packages through a sibling checkout:

```text
~/work/project/deepseek-harness
~/work/project/dsh-stream
```

`prepare` / `build` transpile `src/` with tsdown and do not need that sibling. They emit `lib/index.js` (Host) and `lib/client.js` (browser ModuleLoader bundle).

## License

[MIT](LICENSE)
