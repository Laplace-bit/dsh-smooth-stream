# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the TypeScript plugin. Host logic lives directly under `src/`; browser code, React components, hooks, locales, and CSS Modules live in `src/client/`. Keep the public entry points in `src/index.ts` and `src/client/index.ts` small. Tests in `tests/` distinguish browser and host behavior with names such as `stream.client.spec.tsx` and `settings.host.spec.tsx`.

`benchmarks/` and `scripts/run-stream-benchmark.mjs` hold the stream benchmark. `repro/` is a standalone browser reproduction; `docs/` contains the site and media. `lib/` and `repro/bundle.js` are generated. Harness contracts are documented at `../deepseek-harness/docs/`; reference that sibling directory instead of duplicating its guidance or using an absolute path.

## Build, Test, and Development Commands

- `pnpm install` installs the locked dependencies. Use Node.js `^22.19.0` or `>=24`.
- `pnpm build` builds the host ESM library and browser client bundle into `lib/`.
- `pnpm typecheck` runs strict TypeScript checks without emitting files.
- `pnpm test` runs the full Vitest suite once under jsdom.
- `pnpm exec vitest run tests/stream.client.spec.tsx` runs one test file.
- `pnpm benchmark` records stream-engine performance; review result changes manually.
- `pnpm build:repro` rebuilds the standalone reproduction bundle after changing `repro/main.tsx` or its styles.

## Coding Style & Naming Conventions

Follow the existing two-space indentation, single quotes, no semicolons, and trailing commas. Include `.ts`/`.tsx` extensions in imports and use `import type` for types. React components and files use `PascalCase`; hooks start with `use`; constants use `UPPER_SNAKE_CASE`. Scope styles with `*.module.css`. Preserve the Host/client boundary: browser dependencies must pass `tsdown.config.ts` purity checks, and cross-plugin collaboration should use Cordis services rather than value imports.

## Testing Guidelines

Use Vitest, Testing Library, and jsdom. Name tests `*.spec.tsx` and add regressions to the relevant host or client suite. Control animation, timers, layout metrics, and globals deterministically, then clean them up. There is no coverage threshold; every behavioral fix should add a focused assertion. Before submitting, run `pnpm typecheck`, `pnpm test`, and `pnpm build`.

## Commit & Pull Request Guidelines

History uses concise Conventional Commit subjects: `feat: add ...`, `fix: prevent ...`, `docs: update ...`, and `chore: release ...`. Keep commits focused and summaries imperative. Pull requests should explain user-visible effects, call out Harness API or configuration changes, list verification commands, and link issues. Include screenshots or a short recording for settings, rendering, scrolling, or other motion-sensitive UI changes.
