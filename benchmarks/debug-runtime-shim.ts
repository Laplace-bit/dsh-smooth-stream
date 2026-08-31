import { DEFAULT_STREAM_DEBUG_TUNING } from '../src/settings.ts'

/** Browser diagnostics are intentionally absent from the pure benchmark. */
export const debugRuntime = {
  activeTuning: () => DEFAULT_STREAM_DEBUG_TUNING,
  reportFollow: () => {},
}
