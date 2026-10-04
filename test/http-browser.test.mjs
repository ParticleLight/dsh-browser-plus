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

test('a page on another site cannot pop our window open', async () => {
  // 这两个端点没有认证，而任何网页都能对 localhost 发不带预检的 POST —— 没有这道门，
  // 随便一个网站就能把我们的浏览器窗口弹出来（2026-10-04 review 发现）。
  let opened = 0
  const { ctx, web } = context({ ensureWindowVisible: async () => { opened += 1 } })
  apply(ctx)
  const open = web.routes.find(route => route.path === OPEN_PATH)
  const status = web.routes.find(route => route.path === STATUS_PATH)

  const hostile = response()
  await open.handler({ method: 'POST', headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' } }, hostile)
  assert.equal(hostile.statusCode, 403)
  assert.equal(opened, 0, 'the window was not opened')

  const sameOrigin = response()
  await open.handler({ method: 'POST', headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }, sameOrigin)
  assert.equal(sameOrigin.statusCode, 200)
  assert.equal(opened, 1)

  const noOrigin = response()
  await open.handler({ method: 'POST' }, noOrigin)
  assert.equal(noOrigin.statusCode, 200, 'a client without an Origin header (curl, the smoke suite) still works')

  const hostileStatus = response()
  await status.handler({ method: 'GET', headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' } }, hostileStatus)
  assert.equal(hostileStatus.statusCode, 403)
})
