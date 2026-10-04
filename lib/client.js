/**
 * dsh-browser-plus — client half.
 *
 * One right-sidebar tab whose whole job is to put the shared browser window on
 * screen: picking "浏览器" from the rightbar's add list opens the window, and
 * the panel keeps a button for raising it again. It talks to the plugin's own
 * HTTP route (`src/http-browser/index.ts`), because a third-party client bundle
 * has no generated Remote surface to call a server-side method through.
 *
 * This file is the browser bundle's source in the client-modules factory
 * format: running it only registers the factory, and the module body runs when
 * the plugin is first materialized. `scripts/build-client.mjs` copies it to
 * `lib/client.js` — it is one file with no imports beyond the platform table,
 * so no bundler is involved.
 */
window.__ModuleLoader__.load({
  id: 'dsh-browser-plus',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    /** Implementation identity; also the key its body registers under. */
    const IMPLEMENTATION_ID = 'dsh-browser-plus'
    /** Tab kind: a page type, opened by kind and recognizing no address. */
    const KIND = 'dsh-browser-plus'
    const OPEN_PATH = '/api/dsh-browser-plus/open'
    const STATUS_PATH = '/api/dsh-browser-plus/status'

    const COPY = {
      zh: {
        title: '浏览器',
        description: '打开共享浏览器窗口',
        open: '打开浏览器窗口',
        busy: '正在打开…',
        opened: '浏览器窗口已打开。',
        failed: '打开失败：',
        tasks: (count) => (count > 0 ? '当前有 ' + String(count) + ' 个浏览器任务' : '还没有浏览器任务'),
      },
      en: {
        title: 'Browser',
        description: 'Open the shared browser window',
        open: 'Open browser window',
        busy: 'Opening…',
        opened: 'The browser window is open.',
        failed: 'Could not open it: ',
        tasks: (count) => (count > 0 ? String(count) + ' browser task(s) open' : 'no browser task yet'),
      },
    }

    /** The panel's copy, read at render so a language switch needs no reload. */
    function copy() {
      try {
        const declared = String(document.documentElement.getAttribute('lang') || navigator.language || '')
        return declared.toLowerCase().indexOf('zh') === 0 ? COPY.zh : COPY.en
      } catch (error) {
        return COPY.zh
      }
    }

    /** POST the open endpoint; resolve to a message, never throw at the renderer. */
    function requestOpen() {
      return fetch(OPEN_PATH, { method: 'POST' }).then((response) => response.json().catch(() => null).then((body) => {
        if (!response.ok || body === null || body.ok !== true) {
          throw new Error(body !== null && typeof body.error === 'string' ? body.error : 'HTTP ' + String(response.status))
        }
        return true
      }))
    }

    /** Read the task count for the status line; a failure is not worth a notice. */
    function requestStatus() {
      return fetch(STATUS_PATH).then((response) => response.json()).then((body) => (body !== null && body.ok === true && typeof body.tasks === 'number' ? body.tasks : null)).catch(() => null)
    }

    const PANEL_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      padding: '16px',
      color: 'inherit',
      font: 'inherit',
    }
    const BUTTON_STYLE = {
      alignSelf: 'flex-start',
      padding: '6px 14px',
      border: '1px solid currentColor',
      borderRadius: '6px',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      cursor: 'pointer',
    }
    const NOTE_STYLE = { opacity: 0.7, fontSize: '12px' }

    /** The panel body: it opens the window as soon as it is mounted. */
    function BrowserPanel() {
      const t = copy()
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const [tasks, setTasks] = React.useState(null)

      const open = React.useCallback(() => {
        setBusy(true)
        setNote(null)
        requestOpen()
          .then(() => {
            setBusy(false)
            setNote({ ok: true, text: t.opened })
            return requestStatus().then((count) => setTasks(count))
          })
          .catch((error) => {
            setBusy(false)
            setNote({ ok: false, text: t.failed + String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) })
          })
      }, [t])

      // The tab itself is the affordance: opening it opens the window.
      React.useEffect(() => {
        open()
        requestStatus().then((count) => setTasks(count))
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      return React.createElement('div', { style: PANEL_STYLE },
        React.createElement('button', { type: 'button', style: BUTTON_STYLE, disabled: busy, onClick: open }, busy ? t.busy : t.open),
        note !== null ? React.createElement('div', { style: NOTE_STYLE, role: 'status' }, note.text) : null,
        tasks !== null ? React.createElement('div', { style: NOTE_STYLE }, t.tasks(tasks)) : null,
      )
    }

    exports.inject = ['slots', 'sidebarRightTabs']
    exports.apply = (ctx) => {
      const slots = ctx.get('slots')
      const tabs = ctx.get('sidebarRightTabs')
      if (slots === undefined || tabs === undefined) return
      ctx.effect(() => tabs.register({
        id: IMPLEMENTATION_ID,
        kind: KIND,
        priority: 'extension',
        title: () => copy().title,
        guide: [{
          id: 'open',
          order: 40,
          title: () => copy().title,
          description: () => copy().description,
        }],
      }), 'dsh-browser-plus:type')
      ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
        name: 'sidebar.right.pane.tab',
        key: IMPLEMENTATION_ID,
      }, BrowserPanel)), 'dsh-browser-plus:body')
    }
    return module.exports
  },
})
