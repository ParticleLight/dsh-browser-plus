/**
 * Bridge between the Agent's todo list and the shared browser window.
 *
 * DSH keeps each Agent's plan as a session projection (`todos`, written by
 * `todo_write` and folded from `todo/write` events). The floating orb in the
 * browser window renders that plan, but the browser host is a child process that
 * can only see what the parent hands it — so this row subscribes to the
 * projection change feed and mirrors the plan into the browser provider.
 *
 * Every dependency here is optional on purpose. A deployment without the
 * projection registry, or without the todo tool mounted at all, must still get a
 * working browser: the orb then simply has no plan to show and falls back to the
 * task's own status and last browser action.
 * @module dsh-browser-plus/task-todos
 */

import type { Context } from '@deepseek-ai/cordis'

/** One entry as this bridge forwards it (the provider validates again). */
interface TodoItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** The browser seam surface this bridge uses. */
interface TodoSink {
  pushTaskTodos?(taskKey: string, todos: readonly TodoItem[]): Promise<void>
}

/** Minimal shape of `ctx.sessionProjections` (kept structural). */
interface ProjectionRegistry {
  onChanged(listener: (session: { readonly id?: unknown }, key: string, value: unknown, seq: number) => void): () => void
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-task-todos'

/** The browser seam; the projection registry is injected optionally below. */
export const inject = ['browser']

/** Keep at most this many entries — the orb shows a short list, not a backlog. */
const MAX_ITEMS = 40

/** Keep one entry short enough to read in a popover. */
const MAX_CONTENT = 160

/**
 * Normalize whatever the projection holds into the orb's three states. Anything
 * unrecognized becomes `pending` rather than being dropped: a plan line the UI
 * cannot classify is still a line the human asked to see.
 * @param value - the projection's raw `todos` value.
 * @returns the entries to forward.
 */
function normalize(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return []
  const items: TodoItem[] = []
  for (const raw of value) {
    const entry = raw as { content?: unknown; status?: unknown }
    if (typeof entry?.content !== 'string') continue
    const content = entry.content.trim()
    if (content === '') continue
    const status = entry.status === 'completed' || entry.status === 'in_progress' ? entry.status : 'pending'
    items.push({ content: content.slice(0, MAX_CONTENT), status })
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

/**
 * Register the bridge.
 * @param ctx - plugin context carrying the browser seam.
 */
export function apply(ctx: Context): void {
  const browser = (ctx as unknown as { readonly browser?: TodoSink }).browser
  if (browser === undefined || typeof browser.pushTaskTodos !== 'function') return
  const push = browser.pushTaskTodos.bind(browser)
  // `ctx.inject` keeps the row loadable when the registry is absent: the
  // callback simply never runs and the browser keeps working without a plan.
  ctx.inject(['sessionProjections'], (scoped: Context) => {
    const registry = (scoped as unknown as { readonly sessionProjections?: ProjectionRegistry }).sessionProjections
    if (registry === undefined || typeof registry.onChanged !== 'function') return
    registry.onChanged((session, key, value) => {
      if (key !== 'todos') return
      const taskKey = typeof session?.id === 'string' ? session.id : ''
      if (taskKey === '') return
      // The tool layer keys browser tasks by the calling Agent's id, which is the
      // session id — so a plan written by an Agent lands on that Agent's task.
      void push(taskKey, normalize(value)).catch(() => undefined)
    })
  })
}
