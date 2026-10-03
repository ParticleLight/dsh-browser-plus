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
  assert.ok(script.includes("'malformed-' + index"), 'malformed task keys get a synthetic key instead of a broken binding')
  assert.ok(script.includes("row.disabled = task.active === true || !(typeof task.key === 'string' && task.key.trim() !== '')"), 'and those rows stay disabled')
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
  assert.match(closeBlock, /if \(isPanelOpen\(panel\)\) beginSurfaceClose\(panel\)/, 'collapse closes bookmarks (through the shared exit)')
  assert.match(closeBlock, /if \(isPanelOpen\(trailPanel\)\) beginSurfaceClose\(trailPanel\)/, 'collapse closes the trail (through the shared exit)')
  assert.match(closeBlock, /if \(isPanelOpen\(taskPanel\)\) beginSurfaceClose\(taskPanel\)/, 'collapse closes tasks (through the shared exit)')
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
  // Home is the browser's own new-tab page (a data: document), so the button is
  // relayed to the host instead of navigating the page itself.
  assert.ok(script.includes("emitPageAction('home')"), 'has home action')
  assert.ok(script.includes('bookmarkList'), 'has bookmarks logic')
  // Bookmarks deliberately do NOT use localStorage any more: it is per origin, so
  // the list has to come from the host (see the bookmarks test below).
  assert.ok(!script.includes('dsh-chrome-bookmarks'), 'bookmarks are not per-origin')
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
  assert.ok(script.includes("popup.style.left = g.left + 'px'"), 'anchored under its trigger')
  assert.ok(script.includes("popup.style.top = g.top + 'px'"), 'just below it')
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

test('a loading tab shows a spinner and turns reload into stop', () => {
  const script = buildPageChromeScript()
  assert.match(script, /#bar #stop \{ display:none; \}/, 'stop is hidden while idle')
  assert.match(script, /#bar\.loading #reload \{ display:none; \}/, 'loading swaps reload out')
  assert.match(script, /#bar\.loading #stop \{ display:block; \}/, 'loading swaps stop in')
  assert.match(script, /#tabstrip \.tab \.fav\.loading \{/, 'the favicon slot becomes a spinner')
  assert.match(script, /animation:dshSpin/, 'the spinner animates')
  // The toolbar follows the ACTIVE tab, not the task as a whole.
  assert.match(script, /const activeTab = tabs\.find\(candidate => candidate && candidate\.active === true\)/)
  assert.match(script, /bar\.classList\.toggle\('loading', activeTab !== undefined && activeTab\.loading === true\)/)
  // paintTabFavicon must bail out before drawing a letter under the spinner.
  const paint = script.slice(script.indexOf('const paintTabFavicon'), script.indexOf('const renderTabs'))
  assert.match(paint, /slot\.classList\.toggle\('loading', tab\.loading === true\)/)
  assert.match(paint, /if \(tab\.loading === true\) \{ slot\.textContent = ''; return \}/)
})

test('the tab strip is the window frame: draggable, with room for the caption buttons', () => {
  const script = buildPageChromeScript()
  // The host window is frameless (titleBarStyle:hidden + titleBarOverlay), so the
  // strip is the window's first row: it must drag, and it must leave the
  // top-right corner free for the system buttons.
  const stripRule = script.match(/#tabstrip \{[^}]*app-region[^}]*\}/)?.[0] ?? ''
  assert.match(stripRule, /-webkit-app-region:drag/, 'the empty strip drags the window')
  assert.match(stripRule, /padding-right:148px/, 'room for minimise/maximise/close')
  assert.match(script, /#tabstrip \.tab, #tabstrip \.newtab \{ -webkit-app-region:no-drag; \}/, 'tabs and + stay clickable')
  // Escaped quotes: the CSS ships inside a JSON string.
  assert.ok(
    script.includes(String.raw`:host([data-dsh-caption=\"left\"]) #tabstrip`),
    'macOS traffic lights sit on the left',
  )
  assert.match(script, /host\.dataset\.dshCaption = /, 'the chrome decides which side')
})

test('the bookmark bar is Chrome-like, and the page offset follows it', () => {
  const script = buildPageChromeScript()
  assert.ok(script.includes('bookmarkBar'), 'the bar ships')
  assert.match(script, /#bookmarkBar \{ position:fixed; top:84px;/)
  // 入场动画挂在一个单独的 .animate 上：宿主推来的状态（每次导航都会重推）不许播，
  // 只有人手点的那一下才播 —— 否则偏好开着的人每加载一个页面书签栏都会再滑一次。
  assert.ok(script.includes('#bookmarkBar.open { display:block; white-space:nowrap; }'), 'hidden until turned on')
  assert.ok(script.includes('#bookmarkBar.open.animate { animation:dshBarIn'), 'then slides in')
  assert.ok(script.includes('applyBookmarksVisible(!bookmarksVisible, true)'), 'the user toggle is the only path that animates')
  assert.ok(script.includes('animate === true && bookmarksVisible && !wasVisible'), 'and only when it really opened')
  // The chip is inline-block + width:max-content: shrink-to-fit collapsed it to one
  // character wide in the injected shadow root (measured: 30px instead of 132px).
  assert.ok(script.includes('width:max-content; max-width:180px'), 'chips size to their title')
  assert.ok(script.includes('显示书签栏'), 'a menu item turns it on')
  // The page offset has to move with the bar: 84px of toolbar, 118px with the bar.
  // The page's own viewport starts below the frame, so its inset is just the bar —
  // the toolbar is drawn by the frame view and is not part of this document.
  assert.ok(script.includes("const chromeInset = () => CHROME_SURFACE === 'page'"), 'the inset is surface-aware')
  // State comes from the host, because localStorage is per origin.
  assert.ok(script.includes("operation.op === 'bookmarkbar.set'"), 'patched from the host')
  assert.ok(script.includes('window.__dshBookmarkBar = bookmarksVisible'), 'and published for tests')
})

test('the frame chrome relays page actions instead of touching its own document', () => {
  const frame = buildPageChromeScript('t', 'frame')
  const full = buildPageChromeScript('t', 'full')
  // The frame's document is a data: page, so every page-level control is relayed.
  assert.ok(frame.includes("const onFrameSurface = CHROME_SURFACE === 'frame'"), 'the surface decides')
  assert.ok(frame.includes("type: 'page-action'"), 'actions go through the binding')
  for (const verb of ['back', 'forward', 'reload', 'stop', 'home', 'find']) {
    assert.ok(frame.includes("emitPageAction('" + verb + "')"), verb + ' is relayed')
  }
  assert.ok(frame.includes("emitPageAction('navigate', { url: target })"), 'the omnibox is relayed')
  // Home is the browser's own new-tab page, and that is a data: document: a page
  // cannot navigate itself to one, so even the page's copy has to relay it. The
  // old behaviour (jump to a search engine) must be gone from BOTH surfaces.
  assert.ok(full.includes("home.addEventListener('click', () => emitPageAction('home'))"), 'home is relayed from both surfaces')
  assert.ok(!full.includes("location.assign('https://www.bing.com')"), 'home no longer jumps to a search engine')
  // ...while the page's own copy keeps doing it locally, exactly as before.
  assert.ok(full.includes('else history.back()'), 'the page chrome still goes back itself')
  assert.ok(full.includes("else location.assign(target)"), 'and navigates itself')
  // The frame is a separate view: the page's zoom must not scale it or pad it.
  assert.ok(frame.includes("if (CHROME_SURFACE !== 'frame') {"), 'no zoom compensation on the frame')
  // Bookmarking from the frame must save the PAGE's url, not the frame's.
  assert.ok(frame.includes('onFrameSurface ? activeTabUrl() : location.href'), 'the star saves the page url')
  // frame 只有 84px 高：书签栏留在那儿会把文档撑出滚动条（真机截图右边那条带箭头的）。
  assert.ok(frame.includes('#findBar, #toast, #bookmarkBar { display:none !important }'), 'the frame leaves the bookmark bar to the page copy')
  // ⚠️ 这段必须写在 `const CHROME_SURFACE` **之后** —— 写在前面会 TDZ 抛死整个 mount
  // （2026-10-03 真踩过：两个 chrome 表面一起消失，只有 data-dsh-chrome-error 说得清）。
  assert.ok(frame.includes("if (CHROME_SURFACE === 'frame') {\n      document.documentElement.style.overflow = 'hidden'"), 'the frame can never grow a scrollbar (the shadow sheet cannot style the outer html)')
  assert.ok(frame.indexOf("const CHROME_SURFACE = ") < frame.indexOf("document.documentElement.style.overflow = 'hidden'"), 'and that runs only after the surface const exists')
})

test('hovering a toolbar button needs intent, not a pass-over', () => {
  const frame = buildPageChromeScript('t', 'frame')
  // A pointer crossing the toolbar on its way somewhere else must not pop a menu open
  // (the user hit this), so the hover-open is delayed...
  assert.ok(frame.includes('const HOVER_OPEN_DELAY_MS = '), 'the hover open is delayed')
  assert.ok(frame.includes('hoverOpenTimers.set(entry, window.setTimeout('), 'through a per-button timer')
  // ...and leaving the button before the timer fires cancels it — that is the pass-over.
  assert.match(frame, /pointerleave', \(\) => \{\s*\n\s*cancelHoverOpen\(entry\)/, 'leaving the button cancels a pending open')
  // A real open (click, or state pushed by the host) must clear the pending timer too,
  // or the late timer would re-open it as a hover preview and unpin it.
  assert.match(frame, /const openMenu = \(entry, byHover\) => \{\s*\n[\s\S]{0,220}cancelHoverOpen\(entry\)/, 'opening for real cancels the timer')
  // Leaving the button still must NOT schedule a close: the pointer crosses into the
  // page view on its way to the menu and the frame cannot see it any more.
  assert.ok(frame.includes("if (!onFrameSurface) scheduleHoverClose(entry.popup)"), 'leaving still does not close')
})

test('the chrome moves instead of hard-cutting', () => {
  const script = buildPageChromeScript('t', 'page')
  // Popups float in instead of appearing on one frame.
  assert.ok(script.includes('@keyframes dshPopIn'), 'there is an entrance keyframe')
  assert.ok(script.includes('#panel.open, .glass-panel.open, #mainMenu.open, #findBar.open { animation:dshPopIn'), 'every popup uses it')
  assert.ok(script.includes('@keyframes dshDropIn') && script.includes('#toast.open { animation:dshDropIn'), 'the toast drops in')
  assert.ok(script.includes('@keyframes dshTabIn') && script.includes('#tabstrip .tab.enter { animation:dshTabIn'), 'a new tab floats in')
  // The omnibox used to switch background/border/ring on one frame.
  assert.ok(script.includes('#addressWrap { transition:background .15s ease,border-color .15s ease,box-shadow .15s ease; }'), 'the omnibox eases')
  // Only tabs that appear AFTER the first render of this document animate: the chrome
  // is re-injected on every navigation, so animating the first render would pop the
  // whole strip on every page load.
  assert.ok(script.includes('if (tabsRendered && !lastTabIds.includes(tab.id)) {'), 'only genuinely new tabs animate')
  assert.ok(script.includes("button.classList.add('enter')"), 'and they get the entrance class')
  assert.ok(script.includes('tabsRendered = true'), 'the first render is exempt')
  assert.ok(script.includes("target.classList.contains('enter')"), 'the class is dropped when the animation ends, so it cannot fight the drag transform')
  // Reduced motion: the entrance animations are switched off (the loading spinner stays —
  // it carries state, not decoration).
  assert.ok(script.includes('@media (prefers-reduced-motion:reduce)'), 'reduced motion is honoured')
  assert.ok(script.includes('#mainMenu.closing, #findBar.closing { animation:none; }'), 'and turns the entrance animations off')
  // 弹层关闭也要有动画；但「逻辑上关没关」必须**立刻**反映给测试缝，否则冒烟里那些
  // 「点了菜单项菜单就该关了」的断言会被这 150ms 骗到。
  assert.ok(script.includes('@keyframes dshPopOut') && script.includes('#panel.closing, .glass-panel.closing, #mainMenu.closing, #findBar.closing { animation:dshPopOut'), 'a closing menu fades out')
  assert.ok(script.includes("const isPanelOpen = element => element.classList.contains('open') && !element.classList.contains('closing')"), 'logical open ignores a surface that is only fading out')
  assert.ok(script.includes('open: isPanelOpen(entry.popup)'), 'and the test seam reports the logical state')
  assert.ok(script.includes('const cancelPanelClose = element =>'), 're-opening cancels a pending close')
  // 查找栏和菜单共用同一套退场机制（第 41 轮把它抽出来时菜单也一并改用它）。
  assert.ok(script.includes('const beginSurfaceClose = element =>'), 'one shared exit routine')
  assert.ok(script.includes('if (isPanelOpen(findBar)) beginSurfaceClose(findBar)'), 'which the find bar uses too')
  assert.ok(script.includes("findBar.addEventListener('animationend', event => { motionLog.push({ id: 'find'"), 'and the find bar records its own animation events')
  // 图标换面时的短促反馈：星标 / 安全指示共用 popIcon；首帧不播（用 dataset 记上一次状态）。
  assert.ok(script.includes('const popIcon = (element, id) =>'), 'icon swaps share one pop helper')
  assert.ok(script.includes("if (previous !== undefined && previous !== secIcon.dataset.insecure) popIcon(secIcon, 'security')"), 'the security icon cross-fades when the connection kind flips')
  assert.ok(script.includes("if (previous !== undefined && previous !== starSvg.dataset.starred) popIcon(starSvg, 'star')"), 'and the star pops when the page gets bookmarked')
  // 顺带修的真 bug：frame 表面原来用**自己的** location 判断星标（那是宿主的一张 data: 页）。
  assert.ok(script.includes("const tab = CHROME_SURFACE === 'frame' ? activeChromeTab() : undefined"), 'the toolbar star asks for the visible tab, not the frame document')
  assert.ok(script.includes('? tab.starred === true'), 'and takes the host\'s verdict — the chrome only receives the redacted origin')
  assert.ok(script.includes('#secIcon, #bookmarks svg { transform-box:fill-box; transform-origin:center; }'), 'and SVG icons pivot on their own centre')
  // 面板里**新增**的一行 / 换值的百分比：只对真的变化播，整表重画不播。
  assert.ok(script.includes('const flashChange = (element, id, name, frames) =>'), 'in-place changes share one short feedback helper')
  assert.ok(script.includes("flashChange(row, 'trail-row', 'dshRowIn',"), 'a new trail row slides in')
  assert.ok(script.includes("flashChange(zoomLevel, 'zoom', 'dshZoomIn',"), 'and the zoom percentage pops')
  // 列表行的悬停高亮是淡进来的（Chrome 也是），并且**真实的 CSS 过渡**要能被读到 ——
  // 只断言「CSS 里写了 transition」等于断言声明，不是行为。
  assert.ok(script.includes('#panel .item { display:flex; align-items:center; gap:8px; padding:7px 9px; border-radius:8px; cursor:pointer; transition:background .12s ease; }'), 'bookmark rows fade their hover')
  assert.ok(script.includes('#trail .activity-item { transition:background .12s ease;'), 'and so do trail rows')
  assert.ok(script.includes("root.addEventListener('transitionstart', event => {"), 'the chrome records real CSS transitions, not just WAAPI animations')
  assert.ok(script.includes("motionLog.push({ id, phase: 'start', name: 'css:' + String(event.propertyName || ''), el: String(target.id || '') })"), 'with the property that actually transitioned, and the element it belongs to')
  assert.ok(script.includes("rows: Array.from(entry.popup.querySelectorAll('.item, .activity-item, .task-row'))"), 'and the panel seam exposes the list rows so a test can hover one for real')
  // 行必须**先插进文档**再动画：游离节点上的 WAAPI 动画会停在 pending，永远不显示。
  assert.ok(script.indexOf('trailList.append(row)') < script.indexOf("flashChange(row, 'trail-row'"), 'the row is in the document before it animates')
  // 书签栏滑下来 + 页面下移跟着过渡（下移量的过渡只在**第二次**应用之后才补上：
  // chrome 每次导航都会重新注入，第一次就带过渡的话每个页面加载内容都会自己滑一下）。
  assert.ok(script.includes('@keyframes dshBarIn') && script.includes('#bookmarkBar.open.animate { animation:dshBarIn'), 'the bookmark bar slides in')
  assert.ok(script.includes("document.documentElement.style.transition = 'padding-top .16s ease'"), 'the page inset eases')
  assert.ok(script.includes('let insetApplied = false') && script.includes('if (insetApplied) return'), 'but only from the second application on')
  // toast 现在淡出，而不是啪一下没了。
  assert.ok(script.includes('@keyframes dshToastOut') && script.includes('#toast.closing { animation:dshToastOut'), 'the toast fades out')
  // 收起不能只靠 animationend：减少动态效果时动画不跑，事件永远不来，toast 会挂住。
  assert.ok(script.includes('window.setTimeout(finishToastTimer, 220)'), 'and hides on a timer, not on animationend alone')
  // toast 靠 translateX(-50%) 居中，落下的关键帧必须带上它，否则动画期间会横着跳一下。
  assert.ok(script.includes('@keyframes dshDropIn { from { opacity:0; transform:translateX(-50%) translateY(-10px) }'), 'the drop-in keeps the toast centred')
  // The recorder the smoke asserts against.
  assert.ok(script.includes('window.__dshChromeMotion'), 'the chrome records what animated')
  assert.ok(script.includes("motionLog.push({ id: 'tab', phase: 'start', name: 'dshTabIn' })"), 'including the tab entrance')
  // 标签节点按 id 复用：重建整条标签栏会让 active/hover 的过渡永远播不出来，
  // 而且没有「前一刻的位置」，关掉一个标签后剩下的只能硬跳。
  assert.ok(script.includes('const tabNodes = new Map()'), 'tab nodes are reused by id')
  assert.ok(script.includes("button.classList.toggle('active', tab.active === true)"), 'the active state is toggled, not re-rendered')
  assert.ok(script.includes('if (tabstrip.firstElementChild !== node.button)'), 'nodes move only when they are out of place')
  // FLIP：位置变了的标签从旧位置滑过去，而不是瞬移。
  assert.ok(script.includes("motionLog.push({ id: 'tab', phase: 'slide'"), 'a reordered strip records a slide')
  assert.ok(script.includes('node.button.animate([{ transform:'), 'and the survivors animate from their old position')
  // 新标签从 0 宽长出来（Chrome 就是这样），所以标签必须裁掉自己的内容，否则图标会溢出去。
  assert.ok(script.includes('@keyframes dshTabIn { from { opacity:0; min-width:0; max-width:0 }'), 'a new tab grows in from zero width')
  assert.ok(script.includes('color .15s ease; overflow:hidden; }'), 'and clips its own contents while it grows')
  // 关掉的标签自己也要收起来（不是「啪」一下没了）。
  assert.ok(script.includes("motionLog.push({ id: 'tab', phase: 'close', name: 'dshTabOut' })"), 'a closed tab records its exit')
  assert.ok(script.includes("[{ opacity: 1, width: width + 'px' }, { opacity: 0, width: '0px' }]"), 'and collapses from its own width to zero')
  assert.ok(script.includes("!window.matchMedia('(prefers-reduced-motion: reduce)').matches"), 'skipping the collapse under reduced motion')
  assert.ok(script.includes('window.setTimeout(() => button.remove(), 400)'), 'with a fallback so no ghost tab is left behind')
  // 监听器只装一次，所以 id 必须从 dataset 现读：捕获的旧 id 在节点复用之后是错的。
  assert.ok(script.includes('const idOfButton = button =>'), 'listeners read the tab id from the dataset')
  assert.ok(script.includes('emitTabClose(chromeSelectedTaskKey, idOfButton(button))'), 'so a close targets the current tab')
  // 复用节点之后，favicon 不能再无条件重画：它会「先摆字母、再异步换 canvas」，每来一次
  // patch 都重画的话，标签图标就会一直闪。
  assert.ok(script.includes('if (node.paintedUrl !== url || node.paintedFavicon !== favicon || node.paintedLoading !== loading) {'), 'the favicon is only repainted when it changed')
  assert.ok(script.includes('const motionLog = []'), 'and the log is declared once')
})

test('the rest of Chrome keybindings, over capabilities we already have', () => {
  const script = buildPageChromeScript()
  assert.ok(script.includes("chord === 'd' || chordCode === 'KeyD'"), 'Ctrl+D bookmarks')
  assert.ok(script.includes("chord === 'b' || chordCode === 'KeyB') && event.shiftKey"), 'Ctrl+Shift+B toggles the bar')
  assert.ok(script.includes("chord === 'r' || chordCode === 'KeyR'"), 'Ctrl+R reloads')
  assert.ok(script.includes("chord === 'h' || chordCode === 'KeyH'"), 'Ctrl+H opens the trail panel')
  assert.ok(script.includes("event.key === 'F5'"), 'F5 reloads')
  // Alt+arrow needs the alt check, and Escape only stops when the stop button is showing.
  assert.ok(script.includes("event.altKey && (event.key === 'ArrowLeft' || event.code === 'ArrowLeft')"), 'Alt+Left goes back')
  assert.ok(script.includes("event.altKey && (event.key === 'ArrowRight' || event.code === 'ArrowRight')"), 'Alt+Right goes forward')
  assert.ok(script.includes("event.key === 'Escape' && stop !== null && getComputedStyle(stop).display !== 'none'"), 'Escape stops a load that is running')
  assert.ok(script.includes('const trailMenu = menus[1]'), 'Ctrl+H targets the trail menu')
})

test('tabs can be dragged to reorder, like Chrome', () => {
  const script = buildPageChromeScript()
  assert.ok(script.includes("type: 'move-tab'"), 'the drag reports through the binding')
  assert.ok(script.includes('const emitTabMove = (taskKey, tabId, toIndex)'), 'and carries the drop index')
  // The drop index is measured against the OTHER tabs\u2019 midpoints, and is the
  // insertion index after the dragged tab is removed \u2014 the same convention the
  // host and the provider splice with.
  assert.ok(script.includes('const tabDropIndex = (clientX, draggedId)'), 'the drop point is computed')
  assert.ok(script.includes('if (clientX > rect.left + rect.width / 2) index += 1'), 'midpoint rule')
  assert.ok(script.includes('const shiftTabsForDrag = drag =>'), 'the other tabs make room')
  assert.ok(script.includes("window.addEventListener('pointermove', onTabDragMove, true)"), 'drag is tracked on the window')
  assert.ok(script.includes("window.addEventListener('pointerup', endTabDrag, true)"), 'and finished there too')
  // Clicking the close button is not a drag: capturing the pointer ate the click.
  assert.ok(script.includes("target.closest('.close') !== null") || script.includes("pressedOn.closest('.close') !== null"), 'the close button is excluded')
  assert.ok(!script.includes('.setPointerCapture(event.pointerId)'), 'no pointer capture: it retargets clicks to the tab')
  assert.ok(script.includes('#tabstrip .tab.dragging'), 'the dragged tab is lifted')
})

test('Chrome tab shortcuts and middle-click close', () => {
  const script = buildPageChromeScript()
  // All of these reach the provider's existing capabilities: new-tab, close-tab
  // and switch-tab over the same binding the toolbar buttons use.
  assert.match(script, /const chromeTabList = \(\) => Array\.isArray\(window\.__dshTabs\) \? window\.__dshTabs : \[\]/)
  assert.match(script, /const activeChromeTab = \(\) => chromeTabList\(\)\.find\(tab => tab && tab\.active === true\)/)
  assert.match(script, /chord === 't' \|\| chordCode === 'KeyT'/, 'Ctrl+T')
  assert.match(script, /chord === 'w' \|\| chordCode === 'KeyW'/, 'Ctrl+W')
  assert.match(script, /chord === 'tab' \|\| chordCode === 'Tab'/, 'Ctrl+Tab')
  assert.match(script, /stepChromeTab\(event\.shiftKey \? -1 : 1\)/, 'Shift reverses it')
  assert.match(script, /emitTabCreate\(chromeSelectedTaskKey\)/)
  assert.match(script, /emitTabClose\(chromeSelectedTaskKey, tab\.id\)/)
  assert.match(script, /const stepChromeTab = delta => \{/)
  // Middle-click anywhere on a tab closes it, without switching to it first.
  assert.match(script, /button\.addEventListener\('auxclick', event => \{/)
  assert.match(script, /if \(event\.button !== 1\) return/)
})

test('find in page: a Chrome-style bar, CSSOM highlights, code-matched shortcuts', () => {
  const script = buildPageChromeScript()
  assert.ok(script.includes(String.raw`id=\"findBar\"`), 'the bar ships')
  assert.match(script, /#findBar\.open \{ display:flex; \}/)
  // Highlights are registered on the document (CSSOM), never as a <style> element and
  // never by mutating the page's DOM.
  assert.match(script, /::highlight\(dsh-find\)\{background:#f0bd69/)
  assert.match(script, /::highlight\(dsh-find-current\)\{background:#f28b25/)
  assert.match(script, /document\.adoptedStyleSheets = document\.adoptedStyleSheets\.concat\(\[findSheet\]\)/)
  assert.match(script, /CSS\.highlights\.set\('dsh-find-current', new Highlight\(current\)\)/)
  assert.match(script, /const collectFindRanges = query =>/)
  assert.match(script, /FIND_LIMIT/, 'the walk is capped')
  assert.match(script, /chord === 'f' \|\| chordCode === 'KeyF'/, 'Ctrl+F matches on code too')
  assert.match(script, /chord === 'l' \|\| chordCode === 'KeyL'/)
  assert.match(script, /window\.__dshChromeFind = \{ open: openFind, close: closeFind/)
  assert.match(script, /mmFind\.addEventListener\('click', \(\) => \{ closeMenu\(mainMenu\); openFind\(\) \}\)/)
})

test('a mount error is reported instead of silently truncating the chrome', () => {
  const script = buildPageChromeScript()
  // The mount is one linear script: an exception anywhere silently removes everything
  // AFTER it. That is exactly how a missing root.getElementById('mmFind') turned into
  // "Ctrl+F does nothing" with no error anywhere. Now the throw is recorded where a
  // test can see it.
  assert.match(script, /const mountSafely = \(\) => \{/)
  assert.match(script, /catch \(error\) \{/)
  assert.match(script, /document\.documentElement\.dataset\.dshChromeError = String\(\(error && error\.message\) \|\| error\)/)
  assert.match(script, /if \(document\.documentElement\) mountSafely\(\)/)
  assert.match(script, /document\.addEventListener\('DOMContentLoaded', mountSafely, \{ once: true \}\)/)
})

test('bookmarks come from the host, not from per-origin localStorage', () => {
  const script = buildPageChromeScript()
  // localStorage is per ORIGIN: a bookmark saved on one site was invisible on every
  // other (measured: saved on iana.org, absent on example.com). The host owns them.
  assert.match(script, /const loadBookmarks = \(\) => Array\.isArray\(window\.__dshBookmarks\) \? window\.__dshBookmarks : \[\]/)
  assert.ok(!script.includes('dsh-chrome-bookmarks'), 'no per-origin bookmark key survives')
  assert.match(script, /type: 'bookmark-add'/)
  assert.match(script, /type: 'bookmark-remove'/)
  // The host pushes the authoritative list back, and the bootstrap carries it too.
  assert.match(script, /operation\.op === 'bookmarks\.set'/)
  assert.match(script, /if \(Array\.isArray\(message\.bookmarks\)\) \{ window\.__dshBookmarks = message\.bookmarks; bookmarksChanged = true \}/)
  assert.ok(script.includes('if (bookmarksChanged) { renderBookmarks(); updateBookmarkStar(); renderBookmarkBar()'), 'the bar re-renders with the list')
  // Saving and removing update locally first (instant feedback) and then tell the host.
  assert.match(script, /emitBookmarkAdd\(\)/)
  // 删除时读**当前**的 key（节点会被复用，闭包里的旧 item 会过期）。
  assert.ok(script.includes('const url = row.dataset.dshKey'), 'the remove handler reads the row\'s current key')
  assert.match(script, /emitBookmarkRemove\(url\)/)
  // 两个收藏列表都按 key 复用节点 + FLIP：删掉中间一项时后面的要滑，不是瞬移。
  assert.ok(script.includes('const reconcileList = (container, keys, create, fill, id) =>'), 'the chrome has one list reconciler')
  assert.ok(script.includes("reconcileList(bookmarkBar, items.map(item => item.url)"), 'the bookmark bar uses it')
  assert.ok(script.includes("reconcileList(bookmarkList, list.map(item => item.url)"), 'and so does the bookmarks panel')
  assert.ok(script.includes("motionLog.push({ id, phase: 'slide', name: String(moved.length) })"), 'moved rows are recorded before they slide')
  // 两个轴都要：书签栏横排（left 变）、面板列表竖排（top 变）。
  assert.ok(script.includes("const dy = Math.round(was.top - box.top)"), 'the slide covers both axes')
  assert.ok(script.includes("node.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }]"), 'and animates both')
  assert.ok(script.includes("if (chip.dataset.title === title) return"), 'a reused chip is only redrawn when its title really changed')
  // 任务缩略图每隔几秒来一帧：新的淡入盖住旧的，旧帧等动画结束再摘（硬换会闪）。
  assert.ok(script.includes('const paintThumbCanvas = (thumb, canvas) =>'), 'thumbnails go through one painter')
  assert.ok(script.includes("const previous = thumb.querySelector('canvas.task-thumb-canvas')"), 'which finds the frame it is covering')
  assert.ok(script.includes("motionLog.push({ id: 'task-thumb', phase: 'start', name: 'dshThumbIn' })"), 'and records the fade')
  assert.ok(script.includes("animation.finished.then(drop, drop)"), 'the old frame is dropped when the fade finishes (or is cancelled)')
  assert.ok(script.includes('#taskPanel .task-thumb > * { grid-area:1 / 1; }'), 'both frames share one grid cell')
  // 前进/后退能不能点由宿主算（frame 读不到页面历史，页面那份的 history.length 不可靠），
  // 而变灰必须是**淡**下去的：按钮的基础过渡要带上 opacity。
  assert.ok(script.includes('const applyNavState = () => {'), 'the chrome has one place that decides nav availability')
  assert.ok(script.includes('back.disabled = !(tab && tab.canGoBack === true)'), 'back follows the host summary')
  assert.ok(script.includes('forward.disabled = !(tab && tab.canGoForward === true)'), 'and so does forward')
  assert.ok(script.includes('button:disabled { opacity:.42; cursor:default; }'), 'disabled buttons dim')
  assert.ok(script.includes('opacity .18s ease,color .18s ease'), 'and dim through a transition, not a snap')
  assert.ok(script.includes('canBack: !back.disabled'), 'the test seam reports it')
  // 工具栏按钮上的字和 toast 正文都是整段换掉的 —— 值真的变了才淡一下。
  // 任务行也要复用节点：整列重建时后面的行会瞬移（书签第 46 轮修过同一个病）。
  assert.ok(script.includes('reconcileList(taskList, keys, () => {'), 'the task rows are reconciled, not rebuilt')
  assert.ok(!script.includes("taskList.textContent = ''"), 'the wholesale clear is gone')
  assert.ok(script.includes("const key = row.dataset.dshTaskKey"), 'the click handler reads the key at click time')
  assert.ok(script.includes("'task-panel')"), 'and the slide is logged under the task panel')
  // 切标签时新露出来的页面从表面色淡进来；**导航不播**（否则每次加载都闪一下）。
  assert.ok(script.includes('#reveal { position:fixed; inset:0; background:#202124; opacity:0; pointer-events:none; }'), 'a surface-coloured overlay covers the viewport')
  assert.ok(script.includes("operation.op === 'reveal'"), 'the chrome reacts to the host\'s reveal patch')
  assert.ok(script.includes("motionLog.push({ id: 'reveal', phase: 'start', name: 'dshReveal' })"), 'and records it for the smoke')
  assert.ok(script.includes('const swapText = (element, next, id) => {'), 'one helper swaps a label with a short fade')
  assert.ok(script.includes("if (element.textContent === value) return"), 'and only when the value really changed')
  assert.ok(script.includes("swapText(taskControl, human ? '交还 Agent' : '接管', 'task-control')"), 'the task control uses it')
  assert.ok(script.includes("swapText(toast, text, 'toast')"), 'and so does the toast body')
  // 任务面板的状态变化也是硬切：圆点换色、当前任务那圈高亮凭空出现。
  assert.ok(script.includes('#taskPanel .task-state { width:7px; height:7px; flex:none; border-radius:50%; background:#8792a1; transition:background .18s ease; }'), 'the status dot eases between states')
  assert.ok(script.includes('#taskPanel .task-row { transition:background .18s ease,border-color .18s ease,box-shadow .18s ease; }'), 'and so does the active row')
  assert.ok(script.includes('#taskPanel .task-state { transition:none; }'), 'both respect reduced motion')
  // 日志条目带上元素 id：只按 className 认元素，按钮（无 class）会全变成 BUTTON。
  assert.ok(script.includes("el: String(target.id || '')"), 'the motion log names the element it belongs to')
})

test('the chrome survives a strict CSP: styles go through CSSOM, never a <style> element', () => {
  const script = buildPageChromeScript()
  // A page whose style-src lacks 'unsafe-inline' drops every <style> element. Measured
  // against style-src 'none': the chrome rendered as unstyled bare buttons — no tab
  // strip, no toolbar, no colours, no layout. CSSOM is not subject to CSP.
  assert.match(script, /const chromeSheet = new CSSStyleSheet\(\)/)
  assert.match(script, /chromeSheet\.replaceSync\(chromeCss\)/)
  assert.match(script, /root\.adoptedStyleSheets = \[chromeSheet\]/)
  assert.match(script, /const chromeCss = "/, 'the CSS travels as a plain string')
  assert.match(script, /if \(!chromeStyled\)/, 'older engines still get a <style> fallback')
  // The injected MARKUP must carry no <style> element at all.
  const markupJson = script.match(/root\.innerHTML = ("(?:[^"\\]|\\.)*")/)?.[1]
  assert.ok(markupJson, 'the markup literal is present')
  const markup = JSON.parse(markupJson)
  assert.ok(!markup.includes('<style>'), 'the markup must not carry a <style> element')
  assert.ok(markup.includes('id="tabstrip"') && markup.includes('id="mainMenu"'), 'and it is the real markup')
  // Inline style ATTRIBUTES are blocked by the same directive, so the markup must
  // not carry any. (Element.style.* writes are CSSOM and are fine.)
  assert.ok(!markup.includes('style="'), 'the markup carries no style attributes')
  // The CSS itself still has to be there, just not as a style element.
  assert.ok(script.includes('#tabstrip'), 'the CSS is still shipped')
})

test('page zoom compensates the chrome instead of scaling it', () => {
  const script = buildPageChromeScript()
  // The zoom itself is a webContents property the host applies; the chrome only
  // undoes its own share of the scale and re-scales the offset it adds to the page.
  assert.match(script, /window\.__dshChromeSetZoom = applyZoomFactor/)
  assert.match(script, /host\.style\.zoom = next === 1 \? '' : String\(1 \/ next\)/)
  // The offset tracks both zoom and the bookmark bar (see chromeInset).
  assert.ok(script.includes('applyPageInset(chromeInset() / next)'))
  assert.match(script, /const syncZoomFromHost = \(\) => \{ applyZoomFactor\(window\.__dshZoom\) \}/)
  // The factor must come from the host. Deriving it from devicePixelRatio looked
  // equivalent and was not: a freshly navigated document's dpr is already scaled,
  // so compensation silently stopped after the first navigation.
  assert.ok(!script.includes('baseDpr'), 'the chrome must not derive the factor itself')
  // Shortcuts match on code too — a synthesised key event carries no key text.
  assert.match(script, /const isPlus = key === '\+' \|\| key === '=' \|\| code === 'Equal' \|\| code === 'NumpadAdd'/)
  assert.match(script, /const isMinus = key === '-' \|\| code === 'Minus' \|\| code === 'NumpadSubtract'/)
  assert.match(script, /const isZero = key === '0' \|\| code === 'Digit0' \|\| code === 'Numpad0'/)
  // …and the row itself: Chrome's ⋮ has − / percent / +, with the percent as reset.
  assert.ok(script.includes(String.raw`id=\"mmZoom\"`), 'the zoom row ships')
  assert.match(script, /emitZoom\(clamped\)/)
  assert.match(script, /type: 'set-zoom'/)
})

test('the address bar hides the scheme and shows a real security indicator', () => {
  const script = buildPageChromeScript()
  // Chrome drops the scheme while the omnibox is unfocused and restores the full
  // URL when it is focused.
  assert.match(script, /const prettifyAddress = href => href\.replace\(\/\^https\?:\[\/\]\[\/\]\/, ''\)/, 'the scheme is stripped')
  // The frame surface cannot read its own location (that document belongs to the
  // host), so it takes the address from the tab summary instead — and prefers the
  // FULL url the host hands it directly, because the summary only carries the
  // origin (the chrome also runs inside the page, which must not see paths).
  assert.ok(script.includes("const shownUrl = CHROME_SURFACE === 'frame' ? (frameAddressUrl || activeTabUrl()) : location.href"), 'the frame address prefers the full url the host pushed')
  assert.ok(script.includes("window.__dshChromeAddress = url => { frameAddressUrl = typeof url === 'string' ? url : ''; refreshAddress() }"), 'which arrives through a frame-only setter')
  assert.ok(script.includes("if (lastAddressUrl !== undefined && lastAddressUrl !== shownUrl && !internal) fadeAddress()"), 'and the text cross-fades when the address really changes')
  assert.ok(script.includes("if (event.key === 'Enter') { event.preventDefault(); const typed = address.value; address.blur(); navigate(typed) }"), 'Enter blurs the omnibox before navigating (blur resets the value)')
  assert.ok(script.includes('const navigate = (typed) =>'), 'so navigate takes the typed value explicitly')
  assert.ok(script.includes("address.value = internal ? '' : prettifyAddress(shownUrl)"), 'unfocused shows the pretty form')
  assert.ok(script.includes("const insecure = !internal && !/^https:/i.test(secUrl)"), 'the lock follows the real scheme')
  assert.match(script, /address\.addEventListener\('focus', \(\) => \{ if \(!isInternalLocation\(\)\) address\.value = location\.href \}\)/, 'focus expands it')
  assert.match(script, /address\.addEventListener\('blur', refreshAddress\)/, 'blur collapses it again')
  // A padlock on an http page is a lie: the lock and the info glyph are both in
  // the markup and CSS swaps them.
  // Escaped quotes: the markup ships inside a JSON string.
  assert.ok(
    script.includes(String.raw`class=\"lock\"`) && script.includes(String.raw`class=\"info\"`),
    'both glyphs ship',
  )
  assert.match(script, /#secIcon\.insecure \.lock \{ display:none; \}/)
  assert.match(script, /#secIcon\.insecure \.info \{ display:block; \}/)
  assert.ok(script.includes("const insecure = !internal && !/^https:/i.test(secUrl)"), 'a padlock on http is a lie')
  assert.match(script, /secIcon\.classList\.toggle\('insecure', insecure\)/)
  assert.match(script, /secIcon\.setAttribute\('aria-label', label\)/)
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
  assert.ok(script.includes("{ id: 'main', popup: mainMenu, trigger: mainMenuBtn, width: 264, onOpen: renderMainMenu }"), 'the menu is wired up')
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
  // 成功回调把画布交给 paintThumbCanvas（它负责盖掉 fallback、并让旧帧淡出）。
  const end = script.indexOf('paintThumbCanvas(thumb, canvas)', start)
  assert.ok(end !== -1, 'success callback hands the canvas to the thumbnail painter')
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
  assert.match(applyBlock, /if \(tasksOpen\) showSurface\(taskPanel\); else if \(isPanelOpen\(taskPanel\)\) beginSurfaceClose\(taskPanel\)/, 'apply toggles taskPanel from tasksOpen')
  assert.match(applyBlock, /if \(trailOpen\) showSurface\(trailPanel\); else if \(isPanelOpen\(trailPanel\)\) beginSurfaceClose\(trailPanel\)/, 'apply toggles trailPanel from trailOpen')
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
  const closeStart = script.indexOf('const closeMenu = (popup, reason) => {')
  const openStart = script.indexOf('const openMenu = (entry, byHover) => {')
  assert.ok(closeStart !== -1 && openStart > closeStart, 'closeMenu is defined before openMenu')

  const closeBlock = script.slice(closeStart, openStart)
  assert.match(closeBlock, /popup\.classList\.remove\('open'\)/, 'closeMenu removes the open class')
  assert.match(closeBlock, /syncWorkspacePanels\(\)/, 'closeMenu syncs workspace state')
  assert.match(closeBlock, /setAttribute\('aria-expanded', 'false'\)/, 'closeMenu clears the trigger state')
  // Hovering away must not read as a close on the frame: the pointer has to cross the
  // gap into the page's menu, so the frame only starts the page's grace timer.
  assert.match(closeBlock, /if \(reason !== 'hover'\) emitPanelState\(entry\.id, false\)/, 'a hover-out relays nothing')
  // The frame must not close when the pointer leaves its button: it cannot see the
  // pointer once it is over the page, so it cannot tell "heading for the menu" from
  // "walking away". Getting this wrong made the menu unreachable by mouse.
  const script2 = buildPageChromeScript()
  // Leaving the button now also cancels a pending hover-open (a pointer that only
  // crossed the button must not pop the menu), but it still must not CLOSE anything.
  assert.match(script2, /entry\.trigger\.addEventListener\('pointerleave', \(\) => \{\s*\n\s*cancelHoverOpen\(entry\)\s*\n\s*if \(!onFrameSurface\) scheduleHoverClose\(entry\.popup\)/, 'the frame leaves hover-close to the page')

  const openBlock = script.slice(openStart, script.indexOf('const toggleMenu', openStart))
  assert.match(openBlock, /anchorPopup\(entry\.popup, entry\.trigger, entry\.width\)/, 'openMenu anchors the popup to its trigger')
  assert.match(openBlock, /showSurface\(entry\.popup\)/, 'openMenu opens the popup (and cancels a pending close)')
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
