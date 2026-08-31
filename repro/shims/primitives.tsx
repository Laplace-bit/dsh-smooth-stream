/**
 * Browser-bundle shim for `@deepseek-ai/dsh-client-ui-primitives`. The real
 * package is a prebuilt client bundle that expects harness loader globals;
 * the audit rig only needs one chevron icon for AnimatedDisclosure.
 */
export function IconChevronDownOutline14({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      style={{ display: 'block' }}
    >
      <path
        d="M3 5.5L7 9.5L11 5.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
