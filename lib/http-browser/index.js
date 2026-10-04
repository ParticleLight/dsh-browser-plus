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
/** Absolute path of the "open the window" endpoint. */
export const OPEN_PATH = '/api/dsh-browser-plus/open';
/** Absolute path of the status endpoint. */
export const STATUS_PATH = '/api/dsh-browser-plus/status';
export const name = 'browser-http';
export const inject = ['browser', 'webServer'];
/** Write one JSON response. */
function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(payload));
}
/** One line for the panel to show; never a stack. */
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Register the browser-panel bridge. */
export function apply(ctx, _config = {}) {
    const server = ctx.webServer;
    if (server === undefined)
        return;
    ctx.effect(() => server.register({
        kind: 'exact',
        path: OPEN_PATH,
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, error: 'method not allowed' });
                return;
            }
            try {
                await ctx.browser.ensureWindowVisible();
                sendJson(res, 200, { ok: true });
            }
            catch (error) {
                sendJson(res, 500, { ok: false, error: describe(error) });
            }
        },
    }), 'dsh-browser-plus:open route');
    ctx.effect(() => server.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, error: 'method not allowed' });
                return;
            }
            try {
                const tasks = await ctx.browser.listTasks();
                sendJson(res, 200, { ok: true, tasks: tasks.length });
            }
            catch (error) {
                sendJson(res, 500, { ok: false, error: describe(error) });
            }
        },
    }), 'dsh-browser-plus:status route');
}
