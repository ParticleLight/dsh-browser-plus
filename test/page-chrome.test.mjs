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
  assert.ok(script.includes('taskControl'), 'has a persistent handoff control')
  assert.match(script, /#bar #taskControl { flex:none;/, 'handoff control lives in the top toolbar')
  assert.doesNotMatch(script, /#taskPanel .task-control/, 'handoff control no longer lives inside the task drawer')
  assert.ok(script.includes('toggleTaskControl'), 'uses a shared handoff toggle')
  assert.ok(script.includes("taskControl.addEventListener('pointerdown'"), 'restores Agent control on physical button press')
  assert.ok(script.includes('event.detail === 0'), 'preserves keyboard activation without duplicate mouse toggles')
  assert.ok(script.includes('event.target === host'), 'excludes chrome events from automatic handoff')
  assert.ok(script.includes('textContent'), 'renders task fields as text content')
  assert.ok(script.includes("taskKey !== undefined"), 'guards malformed task keys before binding')
  assert.ok(script.includes("row.disabled = taskKey === undefined"), 'disables malformed task rows')
})


test('toolbar reveals from the top center and collapses its related panels', () => {
  const script = buildPageChromeScript()
  assert.ok(script.includes('toolbarRevealZone'), 'has a top-center hover sensor')
  assert.ok(script.includes("const bar = root.getElementById('bar')"), 'resolves the toolbar before using its state classes')
  assert.ok(script.includes('bar instanceof HTMLElement'), 'guards the toolbar before wiring drawer events')
  assert.ok(script.includes('toolbarReveal'), 'has a circular reveal control')
  assert.ok(script.includes('toolbarHide'), 'has a toolbar collapse control')
  assert.match(script, /translateY\(calc\(-100% - 8px\)\)/, 'toolbar starts above the viewport')
  assert.match(script, /#bar\.open \{ transform:translateX\(-50%\) translateY\(8px\)/, 'open state slides the toolbar down')
  assert.match(script, /toolbarRevealZone\.addEventListener\('pointerenter'/, 'hovering the top center arms the reveal control')
  assert.match(script, /toolbarRevealZone\.addEventListener\('mouseenter'/, 'Mouse Events also arm the reveal control')
  assert.match(script, /width:280px; height:56px/, 'top-center sensor has a forgiving hover area')
  assert.ok(script.includes('isToolbarTriggerPosition'), 'tracks top-center coordinates at the page level')
  assert.match(script, /window\.addEventListener\('pointermove', trackToolbarReveal/, 'Pointer Events arm the trigger from the page')
  assert.match(script, /window\.addEventListener\('mousemove', trackToolbarReveal/, 'Mouse Events arm the trigger from the page')
  assert.ok(script.includes('triggerToolbarFromPage'), 'page-level click trigger opens the drawer without relying on Shadow DOM hit testing')
  assert.match(script, /window\.addEventListener\('pointerdown', triggerToolbarFromPage/, 'pointer click opens the toolbar from the page')
  assert.match(script, /window\.addEventListener\('mousedown', triggerToolbarFromPage/, 'mouse click opens the toolbar from the page')
  assert.ok(script.includes('event.stopImmediatePropagation()'), 'top trigger does not leak a click into the page')
  assert.match(script, /#toolbarRevealZone:hover #toolbarReveal/, 'CSS hover is a direct fallback path')
  assert.match(script, /toolbarReveal\.addEventListener\('click', openToolbar\)/, 'down-arrow click opens the toolbar')
  assert.match(script, /toolbarHide\.addEventListener\('click', closeToolbar\)/, 'up-arrow click collapses the toolbar')
  const closeStart = script.indexOf('const closeToolbar')
  const closeEnd = script.indexOf('window.__dshWorkspaceRender', closeStart)
  const closeBlock = script.slice(closeStart, closeEnd)
  assert.match(closeBlock, /panel\.classList\.remove\('open'\)/, 'collapse closes bookmarks')
  assert.match(closeBlock, /trailPanel\.classList\.remove\('open'\)/, 'collapse closes the trail')
  assert.match(closeBlock, /taskPanel\.classList\.remove\('open'\)/, 'collapse closes tasks')
  assert.match(closeBlock, /syncWorkspacePanels\(\)/, 'collapse persists closed workspace panels')
})

test('page chrome script is top-frame-only, closed-shadow, and idempotent', () => {
  const script = buildPageChromeScript()
  assert.match(script, /window\.top !== window/)
  assert.match(script, new RegExp(PAGE_CHROME_HOST_ID))
  assert.match(script, /attachShadow\(\{ mode: 'closed' \}\)/)
  assert.match(script, /addEventListener\('keydown'/)
  assert.match(script, /data-dsh-browser-chrome/)
  assert.ok(script.includes("data-dsh-browser-ready"), 'marks the chrome only after interactive wiring completes')
  assert.ok(script.includes('<svg'), 'uses inline SVG icons')
  assert.ok(script.includes('currentColor'), 'SVG follows current color')
  assert.ok(script.includes('updateBookmarkStar'), 'star reflects saved state')
  assert.ok(script.includes('button:active'), 'has press feedback')
  assert.ok(script.includes('spinning'), 'reload spins on click')
  assert.ok(script.includes('id=\"trail\"') || script.includes('trail'), 'has trail button')
  assert.ok(script.includes('trailClose'), 'has trail close button')
  assert.ok(script.includes('trailBtn'), 'trail button id is unique from panel')
  assert.ok(script.includes('anchorPopup'), 'secondary menus anchor to their trigger button')
  assert.ok(script.includes('__dshTrail'), 'renders injected trail')
  assert.ok(script.includes('window.stop()'), 'has stop action')
  assert.ok(script.includes("'https://www.bing.com'"), 'has home action')
  assert.ok(script.includes('bookmarksKey'), 'has bookmarks logic')
  assert.ok(script.includes('localStorage'), 'uses localStorage')
  assert.ok(script.includes('data-dsh-user-active'), 'tracks user control')
})


test('page chrome auto-handoffs direct user input but excludes scroll gestures', () => {
  const script = buildPageChromeScript()
  assert.ok(script.includes('pointerdown'), 'tracks direct pointer starts')
  assert.ok(script.includes('pointermove'), 'detects drag scrolling')
  assert.ok(script.includes('pointerup'), 'hands off only after a click-like gesture')
  assert.ok(script.includes('mousedown'), 'supports Electron Mouse Events when Pointer Events are absent')
  assert.ok(script.includes('isScrollKey'), 'filters page scrolling keys')
  assert.ok(script.includes('No wheel listener is intentional'), 'does not hand off on wheel scrolling')
  assert.ok(script.includes('data-dsh-agent-input-until'), 'honors Agent-input suppression')
  assert.ok(script.includes('event.isTrusted'), 'ignores page-script synthetic events')
  assert.ok(script.includes("emitTaskControl(activeTask.key, 'human')"), 'sends human control handoff')
})

test('secondary menus are anchored popups, not fixed docks', () => {
  const script = buildPageChromeScript()
  const panelRule = script.match(/#panel \{[^}]+\}/)?.[0] ?? ''
  const taskRule = script.match(/#taskPanel \{[^}]+\}/)?.[0] ?? ''
  const trailRule = script.match(/#trail \{[^}]+\}/)?.[0] ?? ''
  // The old model pinned each panel to a viewport edge (centre, left, right) and
  // stretched the glass panels to the bottom. Chrome anchors a menu to its own
  // button instead, so no dock geometry may come back.
  assert.doesNotMatch(panelRule, /left:50%/, 'bookmarks no longer centre on the viewport')
  assert.doesNotMatch(taskRule, /left:12px/, 'tasks are not pinned to the left edge')
  assert.doesNotMatch(trailRule, /right:12px/, 'trail is not pinned to the right edge')
  assert.doesNotMatch(script, /\.glass-panel \{[^}]*bottom:12px/, 'panels are not stretched to the bottom edge')
  // Geometry is computed from the trigger at open time.
  assert.match(script, /const anchorPopup = \(popup, trigger, width\)/)
  assert.match(script, /trigger\.getBoundingClientRect\(\)/)
  assert.match(script, /popup\.style\.left = left \+ 'px'/)
  assert.match(script, /popup\.style\.top = top \+ 'px'/)
  assert.match(script, /const menus = \[/)
})

test('secondary menus open on hover over their button', () => {
  const script = buildPageChromeScript()
  assert.match(script, /entry\.trigger\.addEventListener\('pointerenter'/, 'hovering a trigger opens its menu')
  assert.match(script, /entry\.trigger\.addEventListener\('pointerleave'/, 'leaving a trigger schedules a close')
  assert.match(script, /entry\.popup\.addEventListener\('pointerenter'/, 'entering the menu cancels the pending close')
  assert.match(script, /entry\.popup\.addEventListener\('pointerleave'/, 'leaving the menu schedules a close')
  assert.match(script, /const HOVER_CLOSE_DELAY_MS = 220/, 'the gap between button and menu is forgiven')
  assert.match(script, /setAttribute\('aria-expanded'/, 'the trigger reports its expanded state')
  // Click still toggles: hover is an addition, not a replacement (keyboard/touch).
  assert.match(script, /bookmarks\.addEventListener\('click', togglePanel\)/)
  assert.match(script, /tasksBtn\.addEventListener\('click', toggleTasks\)/)
})

test('opening one secondary menu closes the others', () => {
  const script = buildPageChromeScript()
  // Hovering across the toolbar would otherwise stack three popups on top of
  // each other; Chrome shows one menu at a time.
  const openMenu = script.slice(script.indexOf('const openMenu = (entry, byHover) => {'), script.indexOf('const toggleMenu = entry =>'))
  assert.match(openMenu, /for \(const other of menus\) if \(other\.popup !== entry\.popup\) closeMenu\(other\.popup\)/)
})

test('task rows safely render host JPEG thumbnail data', () => {
  const script = buildPageChromeScript()
  assert.match(script, /taskThumbCache\.get\(taskKey\)/, 'thumbnail comes from the client cache')
  assert.doesNotMatch(script, /typeof task\.thumbnail === 'string'/, 'never reads the bulk task.thumbnail field')
  assert.match(script, /startsWith\('data:image\/jpeg;base64,'\)/)
  assert.doesNotMatch(script, /startsWith\('data:image\/'\)/)
  assert.ok(!script.includes('.src'), 'never wires image src under page CSP')
  assert.match(script, /thumb\.isConnected/, 'stale async decode cannot touch unmounted rows')
  assert.match(script, /task-thumb/)
})

test('task thumbnail renderer decodes host JPEG without img-src', () => {
  const script = buildPageChromeScript()
  assert.ok(script.includes("source.startsWith('data:image/jpeg;base64,')"), 'keeps the strict JPEG gate')
  assert.ok(script.includes('atob('), 'decodes base64 payload with atob')
  assert.ok(script.includes('new Blob('), 'wraps decoded bytes in a Blob')
  assert.ok(script.includes('createImageBitmap('), 'decodes pixels via createImageBitmap')
  assert.ok(script.includes("document.createElement('canvas')"), 'paints onto a canvas')
  assert.ok(script.includes('task-thumb-canvas'), 'canvas carries the thumb class')
  assert.ok(!script.includes("document.createElement('img')"), 'never builds an img element')
  assert.ok(!script.includes('image.src = source'), 'never assigns img.src')
})

test('thumbnail trust gate accepts only host JPEG payloads', () => {
  const script = buildPageChromeScript()
  assert.ok(script.includes("startsWith('data:image/jpeg;base64,')"))
  assert.ok(!script.includes("startsWith('data:image/')"))
})

test('secondary menus use the Chrome menu surface, not frosted glass', () => {
  const script = buildPageChromeScript()
  // The old look was a translucent blurred card; Chrome's menus are opaque with
  // an 8px radius, a hairline border and 34px rows.
  // The CSS ships inside a JSON string (escaped newlines), and the media query
  // also starts with the same selector list, so match on the shared rule's body.
  const surface = script.match(/#panel, \.glass-panel, #mainMenu \{[^}]*background:#292a2d[^}]*\}/)?.[0] ?? ''
  assert.match(surface, /background:#292a2d/, 'opaque Chrome menu surface')
  assert.match(surface, /border-radius:8px/)
  assert.match(surface, /border:1px solid #3c4043/)
  assert.doesNotMatch(surface, /backdrop-filter:blur/, 'no frosted glass on a menu')
  assert.doesNotMatch(script, /backdrop-filter:blur\(24px\)/, 'the old bookmarks blur is gone')
  assert.doesNotMatch(script, /backdrop-filter:blur\(30px\)/, 'the old panel blur is gone')
  const row = script.match(/\.menu-item \{[^}]+\}/)?.[0] ?? ''
  assert.match(row, /height:34px/, 'Chrome menu rows are 34px')
  assert.match(row, /border-radius:4px/)
  assert.match(script, /\.menu-sep \{/)
  assert.match(script, /@media \(max-width:760px\) \{ #panel, \.glass-panel, #mainMenu/)
})

test('clicking the address bar selects it, without touching the focus event', () => {
  const script = buildPageChromeScript()
  // Chrome selects the whole omnibox on the first click, so typing replaces it.
  const handler = script.slice(
    script.indexOf("address.addEventListener('pointerdown'"),
    script.indexOf("address.addEventListener('keydown'"),
  )
  assert.match(handler, /root\.activeElement === address/, 'only an unfocused address bar is selected')
  assert.match(handler, /event\.preventDefault\(\)/, 'the default caret placement is suppressed')
  assert.match(handler, /address\.focus\(\)/)
  assert.match(handler, /address\.setSelectionRange\(0, address\.value\.length\)/)
  // Calling select() from the focus handler is what broke CDP Input.insertText
  // into this shadow-DOM input before; the pointerdown path must stay the only one.
  assert.doesNotMatch(script, /addEventListener\('focus',[^)]*select\(\)/)
  // Ctrl+L may still select() explicitly: that is a deliberate shortcut, not the
  // focus-time call that broke insertText.
  assert.match(script, /address\.focus\(\); address\.select\(\)/, 'Ctrl+L keeps selecting the address bar')
})

test('the ⋮ menu is a Chrome-style menu wired to features we already have', () => {
  const script = buildPageChromeScript()
  assert.ok(script.includes('mainMenuBtn'), 'has a three-dot trigger in the toolbar')
  // The markup ships inside a JSON string, so its quotes arrive escaped.
  assert.ok(script.includes(String.raw`id=\"mainMenu\"`), 'has a menu surface')
  assert.ok(script.includes("root.getElementById('mainMenu')"), 'resolves the menu surface')
  for (const id of ['mmNewTab', 'mmBookmark', 'mmBookmarks', 'mmTrail', 'mmTasks', 'mmFullscreen']) {
    assert.ok(script.includes(id), 'menu item ' + id + ' exists')
  }
  assert.match(script, /mainMenuBtn instanceof HTMLButtonElement/, 'the trigger is type-checked before use')
  // It is a secondary menu like the other three: anchored, hover-opened, one at a time.
  assert.match(script, /\{ popup: mainMenu, trigger: mainMenuBtn, width: 264, onOpen: renderMainMenu \}/)
  // Every item drives something the plugin already had rather than a new feature.
  assert.match(script, /mmNewTab\.addEventListener\('click', \(\) => \{ closeMenu\(mainMenu\); if \(typeof chromeSelectedTaskKey === 'string'\) emitTabCreate\(chromeSelectedTaskKey\) \}\)/)
  assert.match(script, /mmBookmark\.addEventListener\('click', \(\) => \{ closeMenu\(mainMenu\); saveCurrentPage\(\) \}\)/)
  assert.match(script, /mmBookmarks\.addEventListener\('click', \(\) => \{ openMenu\(menus\[0\]\) \}\)/)
  assert.match(script, /mmTrail\.addEventListener\('click', \(\) => \{ openMenu\(menus\[1\]\) \}\)/)
  assert.match(script, /mmTasks\.addEventListener\('click', \(\) => \{ openMenu\(menus\[2\]\) \}\)/)
  assert.match(script, /mmFullscreen\.addEventListener\('click', \(\) => \{ closeMenu\(mainMenu\); toggleFullscreen\(\) \}\)/)
  // The bookmark handler is shared with the star, so both paths save the same way.
  assert.match(script, /const saveCurrentPage = \(\) => \{/)
  assert.match(script, /saveBookmark\.addEventListener\('click', saveCurrentPage\)/)
  assert.match(script, /renderMainMenu/)
})

test('glass task cards reserve visual thumbnail space and readable activity timeline', () => {
  const script = buildPageChromeScript()
  assert.match(
    script,
    /#taskPanel \.task-thumb canvas\.task-thumb-canvas \{ display:block; width:100%; height:100%; \}/,
    'canvas thumbnails fill the reserved slot',
  )
  assert.ok(!script.includes('object-fit:cover'), 'no img object-fit rule remains')
  assert.match(script, /width:94px; height:64px/, '94x64 rounded thumbnail slot preserved')
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

test('task thumbnail guards a missing 2d context before clearing the fallback', () => {
  const script = buildPageChromeScript()
  const start = script.indexOf("const ctx = canvas.getContext('2d')")
  assert.ok(start !== -1, 'success callback obtains a 2d context')
  const end = script.indexOf("thumb.textContent = ''", start)
  assert.ok(end !== -1, 'success callback clears the thumb fallback')
  const guard = script.slice(start, end)
  assert.ok(guard.includes('if (!ctx)'), 'guards a missing 2d context before any clear/append')
  assert.ok(guard.includes('return'), 'returns early so the origin/DSH fallback remains')
  assert.ok(guard.includes('bitmap.close()'), 'closes the decoded bitmap on the missing-context path')
})

test('workspace panel persistence exposes injectable panel state and renderer', () => {
  const script = buildPageChromeScript()
  assert.ok(script.includes('__dshWorkspacePanels'), 'reads injected workspace panel state')
  assert.ok(script.includes('__dshWorkspaceRender'), 'exports workspace panel renderer')
  assert.ok(script.includes('applyWorkspacePanels'), 'defines applyWorkspacePanels')
  assert.ok(script.includes('syncWorkspacePanels'), 'defines syncWorkspacePanels')
  assert.ok(script.includes('window.__dshWorkspaceRender = applyWorkspacePanels'), 'mount registers the renderer')
  assert.ok(script.includes('applyWorkspacePanels()'), 'mount applies injected state after functions are defined')
})

test('workspace panels sync to the host through the task action binding', () => {
  const script = buildPageChromeScript()
  assert.ok(script.includes('set-workspace-panels'), 'emits explicit set-workspace-panels action')
  const start = script.indexOf('const emitWorkspacePanels')
  assert.ok(start !== -1, 'defines emitWorkspacePanels next to the binding emitter')
  const emit = script.slice(start, start + 340)
  assert.match(emit, /__dshBrowserTaskAction/)
  assert.match(emit, /typeof binding === 'function'/)
  assert.match(emit, /JSON\.stringify/)
  assert.ok(emit.includes("{ type: 'set-workspace-panels', tasks, trail }"), 'serializes the two boolean panel flags')
})

test('workspace apply opens both panels from true state while toggles stay independent', () => {
  const script = buildPageChromeScript()
  const applyStart = script.indexOf('const applyWorkspacePanels')
  assert.ok(applyStart !== -1, 'has applyWorkspacePanels')
  const applyEnd = script.indexOf('const syncWorkspacePanels', applyStart)
  assert.ok(applyEnd !== -1, 'has syncWorkspacePanels after apply')
  const applyBlock = script.slice(applyStart, applyEnd)
  assert.match(applyBlock, /taskPanel\.classList\.toggle\('open', tasksOpen\)/, 'apply toggles taskPanel from tasksOpen')
  assert.match(applyBlock, /trailPanel\.classList\.toggle\('open', trailOpen\)/, 'apply toggles trailPanel from trailOpen')
  assert.match(applyBlock, /state\.tasks === true/, 'treats only literal true as open for tasks')
  assert.match(applyBlock, /state\.trail === true/, 'treats only literal true as open for trail')
  assert.match(applyBlock, /window\.__dshWorkspacePanels/)
  // Each toggle drives its own menu entry; "one at a time" lives in openMenu,
  // not in the toggles.
  assert.match(script, /const toggleTasks = \(\) => toggleMenu\(menus\[2\]\)/)
  assert.match(script, /const toggleTrail = \(\) => toggleMenu\(menus\[1\]\)/)
})

test('menu open and close keep workspace state in sync', () => {
  const script = buildPageChromeScript()
  const closeStart = script.indexOf('const closeMenu = popup => {')
  const openStart = script.indexOf('const openMenu = (entry, byHover) => {')
  assert.ok(closeStart !== -1 && openStart > closeStart, 'closeMenu is defined before openMenu')

  const closeBlock = script.slice(closeStart, openStart)
  assert.match(closeBlock, /popup\.classList\.remove\('open'\)/, 'closeMenu removes the open class')
  assert.match(closeBlock, /syncWorkspacePanels\(\)/, 'closeMenu syncs workspace state')
  assert.match(closeBlock, /setAttribute\('aria-expanded', 'false'\)/, 'closeMenu clears the trigger state')

  const openBlock = script.slice(openStart, script.indexOf('const toggleMenu', openStart))
  assert.match(openBlock, /anchorPopup\(entry\.popup, entry\.trigger, entry\.width\)/, 'openMenu anchors the popup to its trigger')
  assert.match(openBlock, /entry\.popup\.classList\.add\('open'\)/, 'openMenu opens the popup')
  assert.match(openBlock, /setAttribute\('aria-expanded', 'true'\)/, 'openMenu marks the trigger expanded')
  assert.match(openBlock, /syncWorkspacePanels\(\)/, 'openMenu syncs workspace state')

  const toggleStart = script.indexOf('const toggleMenu = entry =>')
  const toggleBlock = script.slice(toggleStart, script.indexOf('anchorOpenMenus = () =>', toggleStart))
  // Hover previews, a click pins, a second click closes: without the pin step the
  // click that follows a hover-open would close the menu the hover just opened.
  assert.match(toggleBlock, /if \(!entry\.popup\.classList\.contains\('open'\)\) \{ openMenu\(entry\); return \}/, 'toggle opens a closed menu')
  assert.match(toggleBlock, /if \(entry\.pinned !== true\) \{ entry\.pinned = true; return \}/, 'the first click pins a hover preview')
  assert.match(toggleBlock, /closeMenu\(entry\.popup\)/, 'a second click closes a pinned menu')

  // Host-driven panel state must anchor too, not just the click path.
  const anchorBlock = script.slice(script.indexOf('anchorOpenMenus = () =>'), script.indexOf('const toggleTrail'))
  assert.match(anchorBlock, /anchorPopup\(entry\.popup, entry\.trigger, entry\.width\)/, 'apply re-anchors any open menu')
})

/**
 * The page-level toolbar trigger, evaluated from the shipped script with its
 * collaborators injected, so the guard under test is the code that really runs.
 */
function loadToolbarTrigger(script) {
  const start = script.indexOf('    const triggerToolbarFromPage = event => {')
  assert.ok(start >= 0, 'chrome script defines triggerToolbarFromPage')
  const end = script.indexOf('\n    }', start)
  assert.ok(end > start, 'triggerToolbarFromPage ends at four-space indentation')
  const source = script.slice(start, end + 6)
  const state = { suppressed: false, opened: 0 }
  const bar = { classList: { contains: () => false } }
  const trigger = new Function(
    'bar', 'isToolbarTriggerPosition', 'openToolbar', 'agentInputSuppressed',
    `${source}\nreturn triggerToolbarFromPage`,
  )(bar, () => true, () => { state.opened += 1 }, () => state.suppressed)
  return { trigger, state }
}

test('an agent-driven click in the top-centre band is not swallowed by the toolbar', () => {
  const { trigger, state } = loadToolbarTrigger(buildPageChromeScript())
  const makeEvent = () => ({
    isTrusted: true,
    button: 0,
    clientY: 10,
    clientX: 100,
    prevented: 0,
    stopped: 0,
    preventDefault() { this.prevented += 1 },
    stopImmediatePropagation() { this.stopped += 1 },
  })

  // While CDP input is in flight the chrome must let the event through.
  state.suppressed = true
  const agentEvent = makeEvent()
  trigger(agentEvent)
  assert.equal(state.opened, 0, 'does not open the toolbar for agent input')
  assert.equal(agentEvent.prevented, 0, 'does not preventDefault for agent input')
  assert.equal(agentEvent.stopped, 0, 'does not stop propagation for agent input')

  // A human click at the same coordinates keeps the original behaviour.
  state.suppressed = false
  const humanEvent = makeEvent()
  trigger(humanEvent)
  assert.equal(state.opened, 1, 'still opens the toolbar for a human click')
  assert.equal(humanEvent.prevented, 1, 'still suppresses the page click for a human')
  assert.equal(humanEvent.stopped, 1, 'still stops propagation for a human')
})

test('the patch handshake resyncs instead of applying a dropped or reordered patch', () => {
  const script = buildPageChromeScript()
  const marker = 'const decideChromeMessage'
  const start = script.indexOf(marker)
  assert.ok(start >= 0, 'chrome script defines the handshake decision')
  const end = script.indexOf('\n', start)
  const decide = new Function(`${script.slice(start, end)}\nreturn decideChromeMessage`)()

  assert.equal(decide('bootstrap', 1, 1, 0, 0), 'bootstrap')
  assert.equal(decide('patch', 1, 1, 1, 0), 'apply', 'a sequential patch applies')
  assert.equal(decide('patch', 1, 3, 1, 0), 'resync', 'a revision gap means a dropped patch')
  assert.equal(decide('patch', 2, 1, 1, 0), 'resync', 'an epoch change means the document reloaded')
  assert.equal(decide('patch', 1, 1, 1, 1), 'resync', 'a replayed patch is not applied twice')
  assert.equal(decide('trail', 1, 1, 1, 0), 'ignore', 'an unknown kind is ignored')
})
