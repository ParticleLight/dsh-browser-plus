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
import type { Context } from '@deepseek-ai/cordis';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "browser-task-todos";
/** The browser seam; the projection registry is injected optionally below. */
export declare const inject: string[];
/**
 * Register the bridge.
 * @param ctx - plugin context carrying the browser seam.
 */
export declare function apply(ctx: Context): void;
