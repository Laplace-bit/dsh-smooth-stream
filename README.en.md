# dsh-smooth-stream

> **Transform jumpy AI outputs into a calm, teleprompter-smooth reading experience.**  
> Physics-based stream rendering and compositor-compensated viewport tracking for the DeepSeek Harness (`dsh`) Web UI.

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
  (Frame-budgeted character reveal)                                    (Transform compensates visual lag)
```

### 1. Dynamic Adaptive Reveal Engine
- **Fractional character debt**: Evaluates reveal velocity from current backlog ($v = 90 + \text{backlog}^{1.25} \times P$). Leisurely when arrival is slow; accelerates smoothly during bursts without ever dumping text walls.
- **Wrap smoothing**: Predictive body follow uses a continuous trajectory with bounded velocity and acceleration; other height growth uses the spring. The 8px budget normally applies to transform decay at about 60Hz. It is not a universal frame-displacement limit: compensation for actual height changes can exceed it.
- **Uniform completion drain**: When the generation finishes, the residual queue drains at a steady speed, creating clean transitions between body, reasoning, and tool calls.

### 2. GPU-Driven Damped Spring Follower
- **Second-order spring physics**: Uses a sub-stepped damped spring ($k=130, c=24, m=1$) to convert discrete height changes into a continuous trajectory.
- **Transform compensation**: With scroll takeover enabled, the real scrollport stays at the bottom and `transform: translate3d` absorbs visual lag within the measured safe space. The engine still reads heights and rectangles and adjusts temporary margins, padding, and scroll position, so it does not guarantee zero reflow. With takeover disabled, the kernel owns bottom-follow.
- **Closed-loop backpressure**: If visual lag fills the predictive runway ($\approx 72\text{px}$), the follower throttles reveal speed (down to $0.55\times$), ensuring text expansion never outpaces the viewport spring.
- **Stall resilience & ProMotion parity**: Clamps elapsed physical time ($\Delta t \le 32\text{ms}$) during main-thread stalls to prevent teleporting catches. Settling dynamics are identical across 60Hz and 120Hz (ProMotion) displays.

### 3. Per-Phase Fold Policy
- Reasoning visibility during generation, visibility after completion, and expanded height are independently configurable.
- The completed turn follows the kernel by default, with explicit expanded and collapsed overrides. See User Preferences below for the conditions under which an override applies.

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

- Host ESM and browser bundles are built separately; use the current `pnpm build` output for sizes. See [How It Works](https://laplace-bit.github.io/dsh-smooth-stream/how-it-works.html) for the mechanism.

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
| 0.2.x (`@deepseek-ai/dsh-client-*` ≥ `0.2.0-rc.0`) | ✅ declared in `peerDependencies`. The takeover now replaces the built-in row in place (0.2.x renders every keyed entry as its own seat), so the kernel's children/locale/inject seats survive, and the new `conversation.chat.reasoning.body` reasoning slot is wired in (see below) |
| 0.1.7 (`@deepseek-ai/dsh-client-*` ≥ `0.1.7-rc.1`) | ✅ the declared range: this is the `peerDependencies` floor. The plugin configuration page moved to the sidebar Plugins panel (`plugins.bundle.config`), assistant steps arrive at two flow parts (`groupPart`), the icon exports were renamed, and the settings seam became a projection (`describe()` / `update()`) — all four are adapted |
| ≤ 0.1.6 (including the 0.1.5-rc desktop kernel) | ⚠️ the code keeps the older seam's compatibility branches (settings registry, size-suffixed icon names), but the range is **no longer declared in `peerDependencies`** and was not exercised for this release |
| 0.1.0-rc.5 - 0.1.0-rc.7 | ✅ older releases (≤ 0.6.1) |
| 0.1.1-rc.2 | ✅ older releases (≤ 0.6.1) |
| 0.1.2-alpha.1 - 0.1.2-alpha.3 | ✅ 0.4.3+ |

- ✅ = compatible; ⚠️ = still loads, but out of the declared range. The 0.1.7 line is this release's target kernel, adapted through one build with runtime probing; the 0.1.5-rc branches stay in the code so a rollback to an older kernel still loads.
- **Kernel 0.2.x added the `conversation.chat.reasoning.body` slot** for the expanded reasoning body (the kernel's own chain-of-thought translation and any later reasoning-body feature register there). When this plugin draws reasoning itself it checks that slot first: while only the kernel's default occupies it the plugin keeps the body (smoothing and auto-scroll included); as soon as another feature replaces the default, the expanded body is handed back to the slot and the plugin's own display-layer translation stands down, so one reasoning row never shows two conflicting translations. Without the slot (older kernels, the shadow-registration fallback) nothing changes.
- **Kernel 0.1.7 moved plugin configuration out of Settings into the sidebar Plugins panel** (`plugins.bundle.config`), hands one assistant step two flow parts at once (`groupPart`), and renamed icon exports from size suffixes to weight suffixes. This release adapts all three at runtime: without the slot the old path stays live, a missing `groupPart` means "every block belongs to this render", and icons are probed name by name.
- **Kernel 0.1.2 removed the `settingsNamespace()` runtime helper** (on ≤ 0.1.1 it was a validating identity function; 0.1.2 keeps only the same-named type). This plugin does not statically import that symbol — it inlines its namespace constant locally and asserts it as the `SettingsNamespace` type.
- **Use Cordis services for cross-plugin collaboration and probe unstable UI exports through the module table.** The host CLI's tsx `paths` mapping can redirect bare imports into host sources, where a renamed or removed symbol can fail startup; primitives therefore use `harnessIcons.ts` / `primitives-compat.tsx`. Platform modules and libraries allowed for inlining still use static imports. `tsdown.config.ts` checks this boundary; `import type` adds no runtime import.

## Presets & Configuration

The plugin defaults to `preset: balanced`. You can tune the cadence in your profile's `cordis.patch.yml`:

| `preset` | Characteristics |
| :--- | :--- |
| `realtime` | Low buffer; closely follows model token arrival |
| `balanced` | Recommended default; balances smoothness and latency |
| `silky` | Generous buffer with gentler acceleration curves |

---

## User Preferences

Open **Plugins → Installed → dsh-smooth-stream** in the Web UI sidebar and use the configuration card on the package page (kernels before 0.1.7 keep **Settings → Plugins → Plugin Configuration**):

**Logarithmic fade** (on by default) adapts the tail from 24 to at most 160 graphemes according to reveal speed, fading answers and expanded thinking from 0% opacity over 240ms with a reversed logarithmic curve that stays translucent longer. Text settles even during network pauses. Turning it off preserves text pacing and scrolling. It follows the motion preference and skips code, formulas and thinking summaries. Browsers without text-range highlighting support retain the existing reveal behavior.

For a local preview, run `pnpm build:repro`, serve the repository with `python3 -m http.server 8765 --bind 127.0.0.1`, and open `http://127.0.0.1:8765/repro/index.html?demo=fade`. This uses the real reveal/fade hooks with synthetic rich-text fixtures. Run `node scripts/verify-logarithmic-fade.mjs` to check and record it (Chrome and `pnpm exec playwright-core install ffmpeg` required; override the Chrome path with `CHROME_BIN`). Reports and recordings go to the ignored `repro/artifacts/logarithmic-fade/` directory.

- **Enable smooth streaming** (default on): Toggles custom stream rendering and follow. Disabling instantly falls back to built-in Harness rendering.
- **Fold behavior**: Per-phase control over how a reasoning block opens and how tall its expanded body grows.
  - **While thinking streams** (expanded by default): Open the reasoning body as it arrives; collapsed leaves it shut until opened by hand.
  - **After it settles** (collapsed by default): Keep the reasoning readable once it stops, or fold it back to its one-line summary.
  - **Expanded height** (limited by default): Limited keeps the body inside its own 300px scroll box; full lets it grow to its whole height and hands scrolling to the conversation.
  - **After a turn completes** (follow kernel by default): Whether a finished turn folds its process into the one-line summary. Choosing keep or collapsed applies the chosen state once to the mounted answer row, after the turn has closed and is foldable; a manual fold is left alone while that row stays mounted, and the state is applied again if the row remounts.
- **Show render diagnostics** (default off): Opens a live HUD on the right side to inspect FPS, character backlog, spring state, and adjust physical parameters in real time.

Upgrade note: `thinkAutoExpand` remains accepted for old configuration files but no longer affects rendering. If you previously disabled auto-expansion, choose **Collapsed** under **While thinking streams** again after upgrading. Without a new setting, the default is expanded. Once a turn policy has applied to an answer row, changing it preserves that row's current state; later turns or reopening the conversation use the new policy. Turns the kernel forces open remain under kernel control.

---

## License

[MIT](LICENSE)
