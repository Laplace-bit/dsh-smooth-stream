/**
 * Type declarations for the DSH 0.1.2 client renderer surface.
 *
 * `@deepseek-ai/dsh-client-ui-renderer` only exists on DSH 0.1.2+; the pinned
 * dev dependency carrying the rc-era shapes is `@deepseek-ai/dsh-client-
 * runtime`, whose `SlotRegistry` is structurally identical. Declaring the new
 * specifier against that installed shape keeps `tsc` honest without pinning
 * the build to one kernel: the runtime resolves the real module through the
 * client module table, and this file erases at compile time.
 */

declare module '@deepseek-ai/dsh-client-ui-renderer/client' {
  export { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
  export type { RootOwnerProps } from '@deepseek-ai/dsh-client-runtime/client'
}
