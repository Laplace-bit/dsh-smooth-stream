// AnimatedDisclosure: the harness DisclosureRow chrome (24px row, hover
// chevron preview, whole-row click/Enter/Space toggle) with one deliberate
// difference - the expanded body stays mounted while collapsed and animates
// between 0fr and 1fr grid tracks, so expand/collapse glides instead of
// snapping. The harness primitive unmounts closed children (`{open &&
// children}`) and a plugin cannot change that in place, so this fork mirrors
// its DOM shape and `data-disclosure-row` contract: host styling keyed on the
// row attribute and the Think chrome keep working unchanged.

import { type KeyboardEvent, type ReactNode } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './TypewriterAssistantNodeView.module.css'

/** Class-name join for optional overlay classes over the chrome defaults. */
function cx(...parts: Array<string | undefined>): string {
  return parts.filter(part => part !== undefined && part !== '').join(' ')
}

export interface AnimatedDisclosureProps {
  icon: ReactNode
  title: string
  open: boolean
  onToggle: () => void
  collapsedContent?: ReactNode
  children?: ReactNode
  rowClassName?: string | undefined
  leadingClassName?: string | undefined
  titleClassName?: string | undefined
  chevronClassName?: string | undefined
}

/**
 * Render one disclosure header whose expanded body is height-animated.
 * @param props - Visual content, controlled open state, and the toggle
 * callback fired by row click and Enter/Space.
 * @returns the animated disclosure row.
 */
export function AnimatedDisclosure({
  icon,
  title,
  open,
  onToggle,
  collapsedContent,
  children,
  rowClassName,
  leadingClassName,
  titleClassName,
  chevronClassName,
}: AnimatedDisclosureProps) {
  const toggleFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onToggle()
  }
  return (
    <div className={css.disclosureRoot} data-open={open || undefined}>
      <div
        className={cx(css.disclosureRow, rowClassName)}
        data-disclosure-row
        data-expandable=""
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={toggleFromKeyboard}
      >
        <span className={cx(css.disclosureLeading, leadingClassName)}>
          {open
            ? <IconChevronDownOutline14 className={chevronClassName} />
            : (
              <>
                <span className={css.disclosureIconIdle}>{icon}</span>
                <IconChevronDownOutline14 className={cx(chevronClassName, css.disclosureChevronHover)} />
              </>
            )}
        </span>
        <span className={cx(css.disclosureTitle, titleClassName)}>{title}</span>
        {!open && collapsedContent}
      </div>
      <div className={css.disclosureContent} data-disclosure-content data-collapsed={open ? undefined : ''}>
        {children}
      </div>
    </div>
  )
}
