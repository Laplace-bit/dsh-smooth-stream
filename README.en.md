# dsh-smooth-stream

> **Transform jumpy AI outputs into a calm, teleprompter-smooth reading experience.**  
> Physics-based stream rendering and zero-reflow viewport tracking for the DeepSeek Harness (`dsh`) Web UI.

English · [中文](README.md) · [Homepage](https://laplace-bit.github.io/dsh-smooth-stream/) · [How It Works](https://laplace-bit.github.io/dsh-smooth-stream/how-it-works.html) · [npm](https://www.npmjs.com/package/dsh-smooth-stream)

---

## The Silky Smooth Feel

Whether reviewing hundreds of lines of complex reasoning or watching fast-paced code generation, `dsh-smooth-stream` delivers a **calm, continuous, and fatigue-free** reading experience:

- **Organic, fluid text expansion**: No more walls of text abruptly snapping onto your screen. Words glide in with an organic rhythm that feels alive yet unhurried.
- **Effortless eye tracking**: The viewport glides as if on a precision-damped rail. Line wraps and code blocks no longer jar your eyes, eliminating cognitive friction.
- **Adaptive cadence**: Leisurely during slow arrivals, smoothly accelerating during high-volume bursts—keeping your screen composed no matter how fast tokens arrive.

---

## Why this exists

Large language models emit tokens in discrete network bursts: hundreds of characters can arrive within milliseconds, followed by tens of milliseconds of silence.

Traditional chat UIs bind DOM rendering and scrolling directly to arrival events, causing two jarring failure modes:
1. **Visual snapping**: Text blocks, tables, and code snippets pop in abruptly, forcing the reader's eye to constantly re-acquire focus.
2. **Scroll jitter and reflow storms**: Hard `scrollTop = scrollHeight` jumps or interrupted `scroll-behavior: smooth` animations restart their easing curves on every chunk, leading to sluggish lag and severe layout thrashing.

`dsh-smooth-stream` decouples **text reveal cadence** from **viewport motion** into two independent dynamical systems, integrating them per animation frame (`requestAnimationFrame`) to ensure uninterrupted continuity.

---

## Architecture & Mechanics

```
[ Model SSE Stream ]
         │
         ▼
 ┌─────────────────┐       Backpressure Damping (0.55x ~ 1.0x)       ┌─────────────────┐
 │  Reveal Engine  │ ◄────────────────────────────────────────────── │  Follow Engine  │
 └────────┬────────┘                                                 └────────┬────────┘
          │ Fractional character debt integration                             │ 2nd-order damped spring (k=130, c=24)
          ▼                                                                   ▼
 [ Progressive DOM Reveal ] ────────────────────────────────────────► [ GPU Compositor Transform ]
  (Per-frame visual delta ≤ 8px)                                       (Zero Reflow / Pure Composite)
```

### 1. Dynamic Adaptive Reveal Engine
- **Fractional character debt**: Evaluates reveal velocity from current backlog ($v = 90 + \text{backlog}^{1.25} \times P$). Leisurely when arrival is slow; accelerates smoothly during bursts without ever dumping text walls.
- **Wrap smoothing**: Caps per-frame visual displacement to $\le 8\text{px}$ during line wraps and new block arrivals, spreading sudden $24\text{--}28\text{px}$ layout steps across several frames.
- **Uniform completion drain**: When the generation finishes, the residual queue drains at a steady speed, creating clean transitions between body, reasoning, and tool calls.

### 2. GPU-Driven Damped Spring Follower
- **Second-order spring physics**: Uses a sub-stepped damped spring ($k=130, c=24, m=1$) to convert discrete height changes into a continuous trajectory.
- **Zero-reflow viewport tracking**: Keeps the real scrollport pinned to the bottom while absorbing residual visual lag entirely via `transform: translate3d` on the message container. No layout-triggering properties are touched during follow.
- **Closed-loop backpressure**: If visual lag fills the predictive runway ($\approx 72\text{px}$), the follower throttles reveal speed (down to $0.55\times$), ensuring text expansion never outpaces the viewport spring.
- **Stall resilience & ProMotion parity**: Clamps elapsed physical time ($\Delta t \le 32\text{ms}$) during main-thread stalls to prevent teleporting catches. Settling dynamics are identical across 60Hz and 120Hz (ProMotion) displays.

### 3. Turn Lifecycle Auto-Collapse
- Reasoning and tool executions remain expanded while streaming.
- Once a turn settles, intermediate processes cleanly fold behind a minimalist `Processed in Xs` summary row, keeping the conversation view focused on final answers.

---

## Visual Comparison

Left: default Web UI. Right: dsh-smooth-stream.

![Left: default Web UI. Right: dsh-smooth-stream.](docs/compare.gif)

---

## Performance & Test Benchmarks

Verified by local browser-level audit suites:

| Gate | Command | Passing Standard |
| :--- | :--- | :--- |
| **Stream Render Audit** | `node scripts/run-render-audit.mjs` | 10/10 clean across 5 streaming patterns; zero regressions |
| **Overflow & Rebound Gate** | `node scripts/verify-overflow.mjs` | Zero over-scroll, zero bounce under burst load |
| **Tail Vibration Probe** | `pnpm test` | Single-frame shift $\le 30\text{px}$, 7-frame amplitude $\le 32\text{px}$ |

- Core ESM bundle is approximately **4.7 kB** (gzipped). See [How It Works](https://laplace-bit.github.io/dsh-smooth-stream/how-it-works.html) for full benchmarks.

---

## Quick Start

### Installation

Inside your DeepSeek Harness repository checkout:

```sh
pnpm dsh plugin --profile web add dsh-smooth-stream
```

If `dsh` is in your system `PATH`:

```sh
dsh plugin --profile web add dsh-smooth-stream
```

Start the interface:

```sh
pnpm dsh web
```

Verify that `[dsh-smooth-stream] plugin loaded!` appears in the host startup logs.

To uninstall: `pnpm dsh plugin --profile web remove dsh-smooth-stream`.

---

## Kernel Compatibility

| DSH kernel | This plugin |
|---|---|
| 0.1.7 (`@deepseek-ai/dsh-client-*` ≥ `0.1.7-rc.1`) | ✅ the declared range: this is the `peerDependencies` floor. The plugin configuration page moved to the sidebar Plugins panel (`plugins.item`), assistant steps arrive at two flow parts (`groupPart`), the icon exports were renamed, and the settings seam became a projection (`describe()` / `update()`) — all four are adapted |
| ≤ 0.1.6 (including the 0.1.5-rc desktop kernel) | ⚠️ the code keeps the older seam's compatibility branches (settings registry, size-suffixed icon names), but the range is **no longer declared in `peerDependencies`** and was not exercised for this release |
| 0.1.0-rc.5 - 0.1.0-rc.7 | ✅ older releases (≤ 0.6.1) |
| 0.1.1-rc.2 | ✅ older releases (≤ 0.6.1) |
| 0.1.2-alpha.1 - 0.1.2-alpha.3 | ✅ 0.4.3+ |

- ✅ = compatible; ⚠️ = still loads, but out of the declared range. The 0.1.7 line is this release's target kernel, adapted through one build with runtime probing; the 0.1.5-rc branches stay in the code so a rollback to an older kernel still loads.
- **Kernel 0.1.7 moved plugin configuration out of Settings into the sidebar Plugins panel** (`plugins.item`), hands one assistant step two flow parts at once (`groupPart`), and renamed icon exports from size suffixes to weight suffixes. This release adapts all three at runtime: without the slot the old path stays live, a missing `groupPart` means "every block belongs to this render", and icons are probed name by name.
- **Kernel 0.1.2 removed the `settingsNamespace()` runtime helper** (on ≤ 0.1.1 it was a validating identity function; 0.1.2 keeps only the same-named type). This plugin does not statically import that symbol — it inlines its namespace constant locally and asserts it as the `SettingsNamespace` type.
- **Never statically import runtime symbols from `@deepseek-ai/*` packages.** The host CLI starts via `node --import tsx/esm`, and tsx applies the host `tsconfig` `paths` mapping, so a bare `@deepseek-ai/*` import from an external plugin may be redirected into the host's own sources — any host-side rename or removal then explodes at boot as a module instantiation error. Type-only imports (`import type`) are unaffected; this release therefore reads primitives out of the module table (`harnessIcons.ts` / `primitives-compat.tsx`).

## Presets & Configuration

The plugin defaults to `preset: balanced`. You can tune the cadence in your profile's `cordis.patch.yml`:

| `preset` | Characteristics |
| :--- | :--- |
| `realtime` | Low buffer; closely follows model token arrival |
| `balanced` | Recommended default; balances smoothness and latency |
| `silky` | Generous buffer with gentler acceleration curves |

---

## User Preferences

Open **Settings → Plugins → Plugin Configuration** in the Web UI:

**Logarithmic fade** (on by default) adapts the tail from 24 to at most 160 graphemes according to reveal speed, fading answers and expanded thinking from 0% opacity over 240ms with a reversed logarithmic curve that stays translucent longer. Text settles even during network pauses. Turning it off preserves text pacing and scrolling. It follows the motion preference and skips code, formulas and thinking summaries. Browsers without text-range highlighting support retain the existing reveal behavior.

For a local preview, run `pnpm build:repro`, serve the repository with `python3 -m http.server 8765 --bind 127.0.0.1`, and open `http://127.0.0.1:8765/repro/index.html?demo=fade`. This uses the real reveal/fade hooks with synthetic rich-text fixtures. Run `node scripts/verify-logarithmic-fade.mjs` to check and record it (Chrome and `pnpm exec playwright-core install ffmpeg` required; override the Chrome path with `CHROME_BIN`). Reports and recordings go to the ignored `repro/artifacts/logarithmic-fade/` directory.

- **Enable smooth streaming** (default on): Toggles custom stream rendering and follow. Disabling instantly falls back to built-in Harness rendering.
- **Auto-expand thinking**: Controls whether reasoning opens automatically while streaming.
- **Collapse finished work** (default on): Folds thoughts and tool steps into a summary line once the turn settles.
- **Show render diagnostics** (default off): Opens a live HUD on the right side to inspect FPS, character backlog, spring state, and adjust physical parameters in real time.

---

## License

[MIT](LICENSE)
