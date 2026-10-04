/**
 * The HTTP bridge the browser panel talks to.
 *
 * The panel lives in the Web GUI, the window lives in the DSH process, and a
 * client bundle has no way to call a server-side plugin method directly: the
 * generated Remote/Typert surface exists for product packages, not for a
 * third-party plugin built with plain tsc. The DSH web server, however, is a
 * service this plugin can register routes on, and the GUI is served from that
 * same origin — so one POST is the whole bridge.
 *
 * Routes (all JSON, no-store):
 *   POST /api/dsh-browser-plus/open   -> { ok: true } once the window is up
 *   GET  /api/dsh-browser-plus/status -> { ok: true, tasks: number }
 *
 * The `webServer` service is declared structurally rather than imported from
 * `@deepseek-ai/dsh-host-webserver`: this row must load wherever the service
 * exists, without taking a build-time dependency on the package that owns it.
 * @module dsh-browser-plus/http-browser
 */
import type { Context } from '@deepseek-ai/cordis';
/** Absolute path of the "open the window" endpoint. */
export declare const OPEN_PATH = "/api/dsh-browser-plus/open";
/** Absolute path of the status endpoint. */
export declare const STATUS_PATH = "/api/dsh-browser-plus/status";
export declare const name = "browser-http";
export declare const inject: string[];
/** Register the browser-panel bridge. */
export declare function apply(ctx: Context, _config?: unknown): void;
