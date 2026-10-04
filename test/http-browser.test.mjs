import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name, OPEN_PATH, STATUS_PATH } from '../lib/http-browser/index.js'

/** A response double: records status, headers and body. */
function response() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(key, value) { this.headers[key] = value },
    end(chunk) { this.body = chunk },
  }
}

/** A web-server double that keeps the registered routes. */
function server() {
  const routes = []
  return { routes, register(route) { routes.push(route); return () => {} } }
}

/** A context with only the two injected services. */
function context({ ensureWindowVisible = async () => {}, listTasks = async () => [] } = {}) {
  const web = server()
  const ctx = {
    effect(fn) { fn() },
    browser: { ensureWindowVisible, listTasks },
    webServer: web,
  }
  return { ctx, web }
}

test('the http row declares the services it needs and registers both routes', () => {
  assert.equal(name, 'browser-http')
  assert.deepEqual(inject, ['browser', 'webServer'])
  const { ctx, web } = context()
  apply(ctx)
  assert.deepEqual(web.routes.map(route => route.path).sort(), [OPEN_PATH, STATUS_PATH].sort())
  assert.ok(web.routes.every(route => route.kind === 'exact'))
})

test('POST /open raises the shared window', async () => {
  let raised = 0
  const { ctx, web } = context({ ensureWindowVisible: async () => { raised += 1 } })
  apply(ctx)
  const route = web.routes.find(candidate => candidate.path === OPEN_PATH)
  const res = response()
  await route.handler({ method: 'POST' }, res)
  assert.equal(raised, 1)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true })
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('/open refuses anything but POST', async () => {
  let raised = 0
  const { ctx, web } = context({ ensureWindowVisible: async () => { raised += 1 } })
  apply(ctx)
  const route = web.routes.find(candidate => candidate.path === OPEN_PATH)
  const res = response()
  await route.handler({ method: 'GET' }, res)
  assert.equal(res.statusCode, 405)
  assert.equal(raised, 0)
})

test('/open reports a failed raise instead of throwing at the server', async () => {
  const { ctx, web } = context({ ensureWindowVisible: async () => { throw new Error('host is unavailable') } })
  apply(ctx)
  const route = web.routes.find(candidate => candidate.path === OPEN_PATH)
  const res = response()
  await route.handler({ method: 'POST' }, res)
  assert.equal(res.statusCode, 500)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'host is unavailable' })
})

test('/status reports the task count', async () => {
  const { ctx, web } = context({ listTasks: async () => [{}, {}] })
  apply(ctx)
  const route = web.routes.find(candidate => candidate.path === STATUS_PATH)
  const res = response()
  await route.handler({ method: 'GET' }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true, tasks: 2 })
})

test('a composition without a web server is left alone', () => {
  const ctx = { effect(fn) { fn() }, browser: { ensureWindowVisible: async () => {}, listTasks: async () => [] } }
  assert.doesNotThrow(() => apply(ctx))
})
