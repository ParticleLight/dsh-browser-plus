import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PAGE_CHROME_HOST_ID,
  buildPageChromeScript,
  normalizeBrowserAddress,
} from '../lib/browser-electron/page-chrome.js'

test('normalizes domains, full URLs, and search terms', () => {
  assert.equal(normalizeBrowserAddress('example.com'), 'https://example.com')
  assert.equal(normalizeBrowserAddress('https://example.com/a'), 'https://example.com/a')
  assert.equal(
    normalizeBrowserAddress('微软积分'),
    'https://www.bing.com/search?q=%E5%BE%AE%E8%BD%AF%E7%A7%AF%E5%88%86',
  )
  assert.equal(normalizeBrowserAddress('javascript:alert(1)'), '')
  assert.equal(normalizeBrowserAddress('file:///C:/secret.txt'), '')
})

test('page chrome exposes a task manager drawer and host binding action', () => {
  const script = buildPageChromeScript()
  assert.ok(script.includes('tasksBtn'), 'has task button')
  assert.ok(script.includes('taskPanel'), 'has task drawer')
  assert.ok(script.includes('__dshTasks'), 'renders injected task state')
  assert.ok(script.includes('__dshTaskRender'), 'exports task renderer')
  assert.ok(script.includes('__dshBrowserTaskAction'), 'emits host switch action')
  assert.ok(script.includes('switch-task'), 'uses explicit switch action')
  assert.ok(script.includes('textContent'), 'renders task fields as text content')
  assert.ok(script.includes("taskKey !== undefined"), 'guards malformed task keys before binding')
  assert.ok(script.includes("row.disabled = taskKey === undefined"), 'disables malformed task rows')
})

test('page chrome script is top-frame-only, closed-shadow, and idempotent', () => {
  const script = buildPageChromeScript()
  assert.match(script, /window\.top !== window/)
  assert.match(script, new RegExp(PAGE_CHROME_HOST_ID))
  assert.match(script, /attachShadow\(\{ mode: 'closed' \}\)/)
  assert.match(script, /addEventListener\('keydown'/)
  assert.match(script, /data-dsh-browser-chrome/)
  assert.ok(script.includes('<svg'), 'uses inline SVG icons')
  assert.ok(script.includes('currentColor'), 'SVG follows current color')
  assert.ok(script.includes('updateBookmarkStar'), 'star reflects saved state')
  assert.ok(script.includes('button:active'), 'has press feedback')
  assert.ok(script.includes('spinning'), 'reload spins on click')
  assert.ok(script.includes('id=\"trail\"') || script.includes('trail'), 'has trail button')
  assert.ok(script.includes('trailClose'), 'has trail close button')
  assert.ok(script.includes('trailBtn'), 'trail button id is unique from panel')
  assert.ok(script.includes('right:12px'), 'trail dock on the right')
  assert.ok(script.includes('__dshTrail'), 'renders injected trail')
  assert.ok(script.includes('window.stop()'), 'has stop action')
  assert.ok(script.includes("'https://www.bing.com'"), 'has home action')
  assert.ok(script.includes('bookmarksKey'), 'has bookmarks logic')
  assert.ok(script.includes('localStorage'), 'uses localStorage')
  assert.ok(script.includes('data-dsh-user-active'), 'tracks user control')
})

test('task drawer docks left without conflicting with the right trail', () => {
  const script = buildPageChromeScript()
  const taskRule = script.match(/#taskPanel \{[^}]+\}/)?.[0] ?? ''
  const trailRule = script.match(/#trail \{[^}]+\}/)?.[0] ?? ''
  assert.match(taskRule, /left:12px/)
  assert.doesNotMatch(taskRule, /right:12px/)
  assert.match(trailRule, /right:12px/)
})

test('task and trail panels can remain open together', () => {
  const script = buildPageChromeScript()
  const taskToggle = script.slice(script.indexOf('const toggleTasks'), script.indexOf('const closeTasks'))
  const trailToggle = script.slice(script.indexOf('const toggleTrail'), script.indexOf('const closeTrail'))
  assert.doesNotMatch(taskToggle, /trailPanel\.classList\.remove/)
  assert.doesNotMatch(trailToggle, /taskPanel\.classList\.remove/)
})

test('task rows safely render host JPEG thumbnail data', () => {
  const script = buildPageChromeScript()
  assert.match(script, /task\.thumbnail/)
  assert.match(script, /startsWith\('data:image\/jpeg;base64,'\)/)
  assert.doesNotMatch(script, /startsWith\('data:image\/'\)/)
  assert.match(script, /document\.createElement\('img'\)/)
  assert.match(script, /task-thumb/)
})

test('thumbnail trust gate accepts only host JPEG payloads', () => {
  const script = buildPageChromeScript()
  assert.ok(script.includes("startsWith('data:image/jpeg;base64,')"))
  assert.ok(!script.includes("startsWith('data:image/')"))
})

test('glass workspace uses frosted materials and responsive dual panels', () => {
  const script = buildPageChromeScript()
  assert.match(script, /backdrop-filter:blur\(24px\)/)
  assert.match(script, /backdrop-filter:blur\(30px\)/)
  assert.match(script, /-apple-system/)
  assert.match(script, /glass-panel/)
  assert.match(script, /@media \(max-width:760px\)/)
  assert.match(script, /height:min\(42vh,320px\)/)
})

test('glass task cards reserve visual thumbnail space and readable activity timeline', () => {
  const script = buildPageChromeScript()
  assert.match(script, /object-fit:cover/)
  assert.match(script, /task-thumb/)
  assert.match(script, /activity-item/)
  assert.match(script, /timeline-rail/)
})

test('glass trail renderer uses the activity timeline DOM', () => {
  const script = buildPageChromeScript()
  assert.match(script, /row\.className = 'activity-item'/)
  assert.match(script, /rail\.className = 'timeline-rail'/)
  assert.match(script, /head\.className = 'activity-day'/)
})
