/**
 * FrameCoordinator: unified per-document frame clock and phased layout scheduler.
 *
 * Replaces competing, uncoordinated rAF loops across text reveal, follow
 * physics, fade painting, and diagnostic sampling. One document owns exactly
 * one live animation frame while any task is active.
 *
 * Strict phase order in every frame:
 * 1. Read Phase: layout reads ONLY when some task declared them dirty.
 * 2. Simulate Phase: pure math / integration (pacing, spring, buckets).
 *    A task returns `true` to stay armed for the next frame.
 * 3. Write Phase: batched DOM mutations (text nodes, transforms, CSS vars,
 *    at most one scrollTop write per owner).
 *
 * Tasks registered later never overtake earlier ones inside a phase, so a
 * task's relative order is its registration order.
 *
 * `requestRead` is the bridge to the previous frame: a task that just wrote
 * layout-affecting DOM (pacing revealed text, mutate() batch) declares that
 * geometry must be re-read at the top of the NEXT frame, before the follow
 * engine simulates. That keeps the "no layout read after a layout write in
 * the same frame" invariant without giving up a same-reveal measurement.
 */

export interface FrameTask {
  readonly id: string
  /** Called if any task marked layout as dirty during the frame cycle. */
  onRead?: ((now: number) => void) | undefined
  /** Physics, trajectory, and character pace calculation. Returns true if active. */
  onSimulate?: ((dtMs: number, now: number) => boolean) | undefined
  /** DOM and visual style mutation phase (transform, text, scrollTop). */
  onWrite?: ((now: number) => void) | undefined
}

export class FrameCoordinator {
  private static coordinators = new WeakMap<Document, FrameCoordinator>()

  private tasks = new Map<string, FrameTask>()
  private rafId: number | null = null
  private lastTs: number | null = null
  /**
   * Owed layout read. Starts false: a fresh coordinator has no unread writes,
   * and starting dirty would keep the clock armed forever after the first
   * frame. Consumers declare reads via {@link markLayoutDirty}.
   */
  private layoutDirty = false
  /** One id per consumer, so an unregister cannot evict a re-registered task. */
  private nextTaskId = 0
  private doc: Document

  private constructor(doc: Document) {
    this.doc = doc
  }

  static forDocument(doc: Document = document): FrameCoordinator {
    let coordinator = FrameCoordinator.coordinators.get(doc)
    if (coordinator === undefined) {
      coordinator = new FrameCoordinator(doc)
      FrameCoordinator.coordinators.set(doc, coordinator)
    }
    return coordinator
  }

  /**
   * Mark that a DOM or geometry change requires a layout read next frame.
   */
  markLayoutDirty(): void {
    this.layoutDirty = true
    this.ensureLoop()
  }

  /**
   * Declare that geometry written since the last frame must be re-read at the
   * top of the next one, and keep the clock running for it.
   */
  requestRead(): void {
    this.markLayoutDirty()
  }

  /**
   * Register or replace an animation/render task. Returns the task id to hand
   * back to {@link unregisterTask}.
   */
  registerTask(task: Omit<FrameTask, 'id'> & { id?: string }): string {
    const id = task.id ?? `frame-task-${this.nextTaskId++}`
    this.tasks.set(id, { ...task, id })
    this.ensureLoop()
    return id
  }

  /**
   * Unregister a task when its stream completes or the element unmounts.
   */
  unregisterTask(id: string | null | undefined): void {
    if (id === null || id === undefined) return
    this.tasks.delete(id)
    if (this.tasks.size === 0 && !this.layoutDirty) this.stopLoop()
  }

  private ensureLoop(): void {
    if (this.rafId !== null) return
    const win = this.doc.defaultView ?? (typeof window !== 'undefined' ? window : null)
    if (win === null) return

    const tick = (now: number) => {
      this.rafId = null

      if (this.lastTs === null) {
        this.lastTs = now
        // First frame after an idle gap only establishes the time base.
        this.ensureLoop()
        return
      }

      const frameIntervalMs = Math.max(0, now - this.lastTs)
      // Clamp frame delta between 1ms and 100ms to avoid physics explosions
      // during main-thread hiccups.
      const dtMs = Math.max(1, Math.min(frameIntervalMs, 100))
      this.lastTs = now

      // 1. Read phase (only when some task declared layout dirty).
      if (this.layoutDirty) {
        this.layoutDirty = false
        for (const task of this.tasks.values()) task.onRead?.(now)
      }

      // 2. Simulate phase (pacing step, spring, lag, bucket math).
      let anyActive = false
      for (const task of this.tasks.values()) {
        if (task.onSimulate?.(dtMs, now) === true) anyActive = true
      }

      // 3. Write phase (transforms, text nodes, CSS variables, scrollTop).
      for (const task of this.tasks.values()) task.onWrite?.(now)

      // Stay armed while a task is active, while a pending read is owed, or
      // while callers keep the clock explicitly running.
      if ((anyActive || this.layoutDirty) && this.rafId === null) {
        this.ensureLoop()
      } else if (!anyActive && !this.layoutDirty) {
        this.lastTs = null
      }
    }

    this.rafId = win.requestAnimationFrame(tick)
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      const win = this.doc.defaultView ?? (typeof window !== 'undefined' ? window : null)
      win?.cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.lastTs = null
  }

  /**
   * Whether this document currently owns a live, still-needed animation
   * frame. A frame that is merely draining an owed read with no registered
   * task left is not considered active work.
   */
  get active(): boolean {
    return this.rafId !== null && (this.tasks.size > 0 || this.layoutDirty)
  }

  /** Number of registered tasks; used by tests to pin the single-clock contract. */
  get taskCount(): number {
    return this.tasks.size
  }

  /**
   * Release every task, drop any owed read, and stop the clock. Used by tests
   * for isolation; production consumers unregister their own task.
   */
  shutdown(): void {
    this.tasks.clear()
    this.layoutDirty = false
    this.stopLoop()
  }
}
