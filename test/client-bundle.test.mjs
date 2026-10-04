import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = new URL('../lib/client.js', import.meta.url)

/** Load the bundle the way the client-modules loader does, capturing the factory. */
async function loadBundle() {
  const body = await readFile(source, 'utf8')
  let entry = null
  const window = { __ModuleLoader__: { load(candidate) { entry = candidate } } }
  const document = { documentElement: { getAttribute: () => 'zh-CN' } }
  const run = new Function('window', 'document', 'navigator', 'fetch', body)
  run(window, document, { language: 'zh-CN' }, () => Promise.reject(new Error('no fetch in this test')))
  assert.ok(entry !== null, 'the bundle must register through window.__ModuleLoader__.load')
  return entry
}

test('the client half registers one extension tab type with a guide entry', async () => {
  const entry = await loadBundle()
  assert.equal(entry.id, 'dsh-browser-plus')
  const exports = entry.factory(() => ({}))
  assert.deepEqual(exports.inject, ['slots', 'sidebarRightTabs'])

  const types = []
  const slots = []
  const ctx = {
    effect(fn) { fn() },
    get(name) {
      if (name === 'sidebarRightTabs') return { register(definition) { types.push(definition); return () => {} } }
      if (name === 'slots') {
        return {
          inject(_name, fn) { fn() },
          register(spec, Component) { slots.push({ spec, Component }); return () => {} },
        }
      }
      return undefined
    },
  }
  exports.apply(ctx)

  assert.equal(types.length, 1)
  const type = types[0]
  assert.equal(type.id, 'dsh-browser-plus')
  assert.equal(type.kind, 'dsh-browser-plus')
  assert.equal(type.priority, 'extension')
  // Deliberately not plain 浏览器: the product's own sandboxed browser tab is
  // titled that, and two identical rows in the add list are a guessing game.
  assert.equal(type.title(''), '共享浏览器')
  assert.equal(type.guide.length, 1)
  assert.equal(type.guide[0].title(), '共享浏览器')
  assert.ok(type.guide[0].description().length > 0)
  assert.equal(slots.length, 1)
  assert.equal(slots[0].spec.name, 'sidebar.right.pane.tab')
  assert.equal(slots[0].spec.key, 'dsh-browser-plus', 'the body registers under the type id')
  assert.equal(typeof slots[0].Component, 'function')
})

test('the client half stands down when the services are absent', async () => {
  const entry = await loadBundle()
  const exports = entry.factory(() => ({}))
  assert.doesNotThrow(() => exports.apply({ effect(fn) { fn() }, get() { return undefined } }))
})

test('the bundle patch carries an exact package-root row', async () => {
  // The client module system resolves a Loader row to a package only when its
  // specifier is the exact package root; a subpath is skipped silently. This
  // test is what keeps that row from being dropped as "redundant".
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const names = [...patch.matchAll(/^\s*-?\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map(match => match[1])
  assert.ok(names.includes('dsh-browser-plus'), 'a row must name the package root: ' + JSON.stringify(names))
})

test('the package root exports a mountable plugin and declares the client half', async () => {
  const root = await import('../lib/index.js')
  assert.equal(root.name, 'browser-plus')
  assert.equal(typeof root.apply, 'function')
  assert.doesNotThrow(() => root.apply())

  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(Array.isArray(manifest.dsh.client.inject))
  assert.equal(manifest.exports['./client'].default, './lib/client.js')
})
