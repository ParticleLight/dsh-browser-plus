# dsh-browser-plus EGO 功能补齐实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** 补齐 dsh-browser-plus 与 EGO 浏览器的全部差距:原生对话框处理、pressKey/doubleClick/hover、文件上传、waitForElement、快照 locator 输出,以及每会话独立窗口 + space 命名。

**Architecture:** 所有交互能力透过现有 CDP \`command\` RPC 直达(无需新增协议 op),唯一新 op 是 \`drainDialog\`(清除/读取 JS 对话框,含 host 侧自动 accept)与窗口相关 \`label\`/\`listWindows\`。三层保持不动:provider(CDP 驱动)→ RemoteElectronViewHost(JSON-RPC)→ host-main(Electron 主进程)。第三梯队把 host 从"单窗口多视图"升级为"每会话一窗口多视图",但继续遵守铁律:绝不 reparent 可见视图、不创建第二个 WebContentsView、Electron 恒为 42.9.3。

**Tech Stack:** TypeScript(tsc NodeNext)、Electron 42.9.3(CDP 1.3)、Node 22+ 原生 test runner、line-delimited JSON-RPC over loopback TCP。

---

## Phase 0:约定与基线

**仓库:** \`F:/deepseekharness/dsh-browser-plus\`(git main,首提交 \`27a9979\`,v0.2.0)

**三个工作区(缺一不可):**

| 角色 | 路径 |
|---|---|
| 源码工作区(改这里) | \`F:/deepseekharness/dsh-browser-plus/\` |
| 构建产物 | 同仓库 \`lib/\`(tsc 输出,已入库) |
| 生效安装(live) | \`C:/Users/Particle Light/.dsh/profiles/web/node_modules/dsh-builtin-browser/\`(安装包名仍是旧名;正式换名安装属发布任务,实施期持续同步此目录) |

**构建/测试/同步命令(pwsh,每次任务末尾使用):**

\`\`\`powershell
# 1. 构建
npm run build                                            # 在仓库根执行;tsc -> lib/

# 2. 全量测试(12 个现有 + 新增)
node --test test/

# 3. 同步 live(仓库 lib/ -> live lib/)
Copy-Item -Force F:/deepseekharness/dsh-browser-plus/lib/browser-electron/host-main.js        "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-builtin-browser\lib\browser-electron\host-main.js"
Copy-Item -Force F:/deepseekharness/dsh-browser-plus/lib/browser-electron/provider.js         "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-builtin-browser\lib\browser-electron\provider.js"
Copy-Item -Force F:/deepseekharness/dsh-browser-plus/lib/browser-electron/page-chrome.js      "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-builtin-browser\lib\browser-electron\page-chrome.js"
Copy-Item -Force F:/deepseekharness/dsh-browser-plus/lib/browser-electron/remote-host.js     "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-builtin-browser\lib\browser-electron\remote-host.js"
Copy-Item -Force F:/deepseekharness/dsh-browser-plus/lib/browser/runtime.js                   "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-builtin-browser\lib\browser\runtime.js"
Copy-Item -Force F:/deepseekharness/dsh-browser-plus/lib/browser/types.js                     "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-builtin-browser\lib\browser\types.js"
Copy-Item -Force F:/deepseekharness/dsh-browser-plus/lib/tool-browser/index.js                "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-builtin-browser\lib\tool-browser\index.js"
\`\`\`

**生效级别:**
- \`host-main.js\` / \`page-chrome.js\` 改动 → 仅回收 Electron child 即生效(下次工具调用自动重启):

\`\`\`powershell
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*host-main*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
\`\`\`

- \`provider.js\` / \`remote-host.js\` / \`runtime.js\` / \`types.js\` / \`tool-browser/index.js\` 改动 → 需**重启 DSH Web** 生效(同 live 目录已同步)。

**铁律(每次改动前默念):**
1. 永不 reparent 可见 WebContentsView(唯一例外:capture 的 CDP 回退临时 detach,且必须恢复)。
2. 页面 chrome 必须留在页面内(closed Shadow DOM),不得变成第二个 WebContentsView。
3. Electron 锁 42.9.3(43.4.1 组合器故障);任何版本升级需 5/5 导航浸泡测试。
4. 新按钮 id 不得与面板 id 重复(曾有 \`id="trail"\` 冲突 bug)。
5. 快照/填充/内容脚本必须过滤 \`closest('[data-dsh-browser-chrome]')\`。
6. 测试断言避开 \`id="x"\` 字面(生成脚本是 \`id=\"x\"\`),用 \`includes('x')\` 或动作字符串。
7. 每个任务独立提交,提交信息 \`feat/fix|test(scoped): ...\`。

**测试文件地图:**

| 文件 | 职责 |
|---|---|
| \`test/page-chrome.test.mjs\` | chrome 脚本行为(纯字符串/函数) |
| \`test/host-composition.test.mjs\` | host-main/provider/remote-host **源码断言**(字符串匹配保护性检查) |
| \`test/provider-actions.test.mjs\` | **新增** — provider 行为测试(FakeHost 记录 CDP 调用序列) |

**fake host 骨架(provider-actions.test.mjs 开头,Task 1 建立):**

\`\`\`js
import test from 'node:test'
import assert from 'node:assert/strict'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

class FakeHost {
  constructor () {
    this.log = []          // { method, params } 每一条 sendCommand
    this.views = []        // 已创建 handle
    this.traces = []       // host.trace 收到的条目
    this.evalReplies = []  // Runtime.evaluate 按调用次序出队;空则回 null
    this.createViewArgs = [] // createView(key, label) 收到的参数
  }
  createView (key, label) {
    this.createViewArgs.push({ key, label })
    const id = \`view-\${this.views.length + 1}\`
    const handle = {
      id,
      sendCommand: async (method, params) => {
        this.log.push({ method, params })
        if (method === 'Runtime.evaluate') {
          const next = this.evalReplies.shift()
          return next === undefined
            ? { result: { value: null } }
            : next
        }
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
        if (method === 'DOM.querySelector') return { nodeId: 42 }
        return {}
      },
    }
    this.views.push(handle)
    return handle
  }
  showView () {}
  destroyView (handle) { this.views = this.views.filter(v => v !== handle) }
  trace (viewId, entry) { this.traces.push({ viewId, entry }) }
}

function makeProvider () {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  return { host, provider, session: null }
}
\`\`\`

---

## Task 1:JS 对话框自动处理(host 侧 accept + provider drain 记录)

**Files:**
- Modify: \`src/browser-electron/host-main.ts\`(createView 处加 Page.enable/DOM.enable + message 监听;新增 \`drainDialog\` op)
- Modify: \`src/browser-electron/remote-host.ts\`(RemoteView 增加 \`clearDialog\`)
- Modify: \`src/browser-electron/provider.ts\`(ElectronViewHandle 增加可选 \`clearDialog?\`;新增私有 \`drainDialog\`;在 execute/snapshot/content/click/type/fillForm 开头调用)
- Modify: \`src/types/electron-shim.d.ts\`(WebContentsDebugger 增加 \`on('message')\`)
- Modify: \`test/host-composition.test.mjs\`(源码断言)
- Create: \`test/provider-actions.test.mjs\`(行为测试)

**行为说明:** host 收到 \`Page.javascriptDialogOpening\` 立即 \`Page.handleJavaScriptDialog({accept:true})\`(页面永不卡死),并把 dialog 详情存入 per-view 最近一条日志。provider 每次页面操作前 \`clearDialog()\` 取走日志(若存在,\`record(s,'dialog',…)\`,模型经 \`browser_history\` 可见)。

**shim 修改(\`src/types/electron-shim.d.ts\`):** 在 \`WebContentsDebugger\` 接口内新增:

\`\`\`ts
    on(event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>) => void): void
\`\`\`

**host-main 修改:** 顶部常量区(\`const traces = …\` 之后)新增:

\`\`\`ts
/** Latest unread JS dialog per view (auto-accepted; read by drainDialog). */
const dialogLogs = new Map<string, unknown>()
\`\`\`

\`createView\` case 中,在 \`view.webContents.debugger.attach(CDP_VERSION)\` 之后(\`setWindowOpenHandler\` 之前)插入:

\`\`\`ts
        // Enable event domains so JS dialogs are observable; both are
        // fire-and-forget — a failure must never block first paint.
        try { void view.webContents.debugger.sendCommand('Page.enable').catch(() => undefined) } catch { /* closed */ }
        try { void view.webContents.debugger.sendCommand('DOM.enable').catch(() => undefined) } catch { /* closed */ }
        // JS dialogs (alert/confirm/prompt) would freeze the page until
        // answered. Auto-accept immediately so automation never stalls, and
        // stash the detail for the provider to surface via drainDialog.
        view.webContents.debugger.on('message', (_event, method, params) => {
          if (method !== 'Page.javascriptDialogOpening') return
          const p = (params ?? {}) as { type?: unknown; message?: unknown; defaultPrompt?: unknown }
          const info = {
            type: String(p.type ?? ''),
            message: String(p.message ?? ''),
            ...typeof p.defaultPrompt === 'string' ? { prompt: p.defaultPrompt } : {},
          }
          dialogLogs.set(viewId, info)
          try {
            void view.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined)
          } catch { /* closing */ }
        })
\`\`\`

在 \`case 'trace'\` 之后新增 case(放在 \`case 'createView'\` 之前):

\`\`\`ts
      case 'drainDialog': {
        const viewId = msg.viewId
        if (viewId === undefined) throw new Error('drainDialog missing viewId')
        const entry = views.get(viewId)
        if (entry === undefined) throw new Error(\`drainDialog: unknown view \${viewId}\`)
        const latest = dialogLogs.get(viewId)
        if (latest !== undefined) dialogLogs.delete(viewId)
        reply(msg.id, { ok: true, result: latest ?? null })
        return
      }
\`\`\`

**remote-host 修改(\`RemoteView\` 类,\`flushAuth\` 方法后新增):**

\`\`\`ts
  /** Read (and clear) the most recent auto-accepted JS dialog for the view. */
  async clearDialog(): Promise<unknown> {
    return this.client.call<{ result: unknown } | null>('drainDialog', { viewId: this.id }).then(r => r?.result ?? null)
  }
\`\`\`

\`DeferredRemoteView\` 同步转发(在 \`restoreAuth\` 后):

\`\`\`ts
  async clearDialog(): Promise<unknown> {
    const view = await this.materializeOnce()
    return view.clearDialog()
  }
\`\`\`

**provider 修改:**

\`ElectronViewHandle\` 接口(\`sendCommand\` 声明后)新增:

\`\`\`ts
  /**
   * Read the most recent auto-accepted JS dialog for this view (and clear it).
   * Optional: hosts without JS-dialog supervision omit it.
   * @returns the dialog detail ({ type, message, prompt? }) or null.
   */
  clearDialog?(): Promise<unknown>
\`\`\`

类内(\`record\` 方法之前)新增:

\`\`\`ts
  /**
   * Pick up (and forget) any JS dialog the host auto-accepted, so the
   * operation trail shows the human/agent what the page asked. Best-effort.
   */
  private async drainDialog(s: Session, handle: ElectronViewHandle): Promise<void> {
    const drainable = handle as { clearDialog?(): Promise<unknown> }
    if (typeof drainable.clearDialog !== 'function') return
    try {
      const dialog = await drainable.clearDialog()
      if (dialog !== null && dialog !== undefined) {
        this.record(s, 'dialog', dialog as Record<string, unknown>, true)
      }
    } catch {
      // Dialog supervision is cosmetic; never fail a page operation for it.
    }
  }
\`\`\`

随后在以下方法体开头(\`signal?.throwIfAborted()\` 之后、任何 sendCommand 之前)各插入一行 \`await this.drainDialog(s, handle)\`:

- \`execute\`: \`const { handle } = this.activeTab(s)\` 之后
- \`snapshot\`: \`const tab = this.activeTab(s)\` 之后(\`await this.drainDialog(s, tab.handle)\`)
- \`content\`: \`const tab = this.activeTab(this.session(session))\` 之后
- \`click\` / \`type\`: \`const { handle } = this.activeTab(s)\` 之后
- \`fillForm\`: \`const tab = this.activeTab(s)\` 之后

以 \`execute\` 为例,改动后开头为:

\`\`\`ts
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, handle)
    try {
\`\`\`

**测试:**

- [ ] **Step 1: 写失败测试**

\`test/host-composition.test.mjs\` 末尾追加:

\`\`\`js
test('host auto-accepts JS dialogs and exposes drainDialog', async () => {
  const source = await readFile(hostPath, 'utf8')
  assert.ok(source.includes("'Page.enable'"), 'enables Page domain')
  assert.ok(source.includes("'DOM.enable'"), 'enables DOM domain')
  assert.match(source, /Page\.javascriptDialogOpening/)
  assert.match(source, /Page\.handleJavaScriptDialog/)
  assert.match(source, /dialogLogs/)
  assert.match(source, /case 'drainDialog'/)
})

test('provider drains auto-accepted dialogs into history', async () => {
  const source = await readFile(providerPath, 'utf8')
  assert.match(source, /clearDialog/)
  assert.match(source, /this\.record\(s, 'dialog'/)
})
\`\`\`

\`test/provider-actions.test.mjs\` 新建(含上方 FakeHost 骨架,再加):

\`\`\`js
test('execute records an auto-accepted dialog before running the script', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  // 桩:clearDialog 返回一次 dialog,之后为 null
  let dialogPings = 0
  host.views[0].clearDialog = async () => {
    dialogPings += 1
    return dialogPings === 1 ? { type: 'confirm', message: 'really?' } : null
  }
  host.evalReplies.push({ result: { value: 42 } })
  const result = await provider.execute(session, { script: '1 + 41' })
  assert.equal(result.ok, true)
  const history = await provider.history(session)
  assert.equal(history[0].action, 'dialog')
  assert.equal(history[0].params.message, 'really?')
})
\`\`\`

- [ ] **Step 2: 运行确认失败**

Run: \`node --test test/host-composition.test.mjs test/provider-actions.test.mjs\`
Expected: 新增断言 FAIL(找不到 \`Page.enable\` 等 / \`clearDialog\` 未定义)。

- [ ] **Step 3: 实现(上述代码全部落位)**

- [ ] **Step 4: 运行确认通过**

Run: \`npm run build && node --test test/\`
Expected: \`# pass N\`(原 12 + 新增 3 = 15 左右),0 fail。

- [ ] **Step 5: 部署并手动验证(仅 host-main,回收 child 即可)**

\`\`\`powershell
Copy-Item -Force F:/deepseekharness/dsh-browser-plus/lib/browser-electron/host-main.js "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-builtin-browser\lib\browser-electron\host-main.js"
Copy-Item -Force F:/deepseekharness/dsh-browser-plus/lib/browser-electron/provider.js "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-builtin-browser\lib\browser-electron\provider.js"
Copy-Item -Force F:/deepseekharness/dsh-browser-plus/lib/browser/types.js "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-builtin-browser\lib\browser\types.js"
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*host-main*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
\`\`\`

在 DSH 会话中:\`browser_open https://example.com\` → \`browser_execute\` 脚本 \`setTimeout(() => { window.confirm('hello from dsh'); }, 0); 'scheduled'\` → 页面不卡(confirm 自动 OK)→ \`browser_history\` 应出现一行 \`#n dialog ok {"type":"confirm",...}\`。(provider 改动需重启 DSH 后再次验证。)

- [ ] **Step 6: Commit**

\`\`\`bash
git add -A
git commit -m "feat(browser): auto-accept JS dialogs and surface them in history"
\`\`\`

---

## Task 2:pressKey(CDP Input.dispatchKeyEvent)

**Files:**
- Modify: \`src/browser/types.ts\`(BrowserPressKeyRequest、BrowserProvider.pressKey)
- Modify: \`src/browser/runtime.ts\`(透传)
- Modify: \`src/browser-electron/provider.ts\`(key 映射表 + pressKey 实现)
- Modify: \`src/tool-browser/index.ts\`(browser_press_key 工具)
- Modify: \`test/provider-actions.test.mjs\`(行为测试)

**types.ts 新增(放在 BrowserTypeRequest 之后):**

\`\`\`ts
/** Key press into the page, as one keyDown+keyUp pair. */
export interface BrowserPressKeyRequest {
  /** The key to press: a single character ('a', '1'), an Enter/Tab/Escape,
   *  navigation key (ArrowUp/ArrowDown/…), Home/End/PageUp/PageDown,
   *  Backspace/Delete, or F1..F12. */
  readonly key: string
  /** Modifier keys held during the press. */
  readonly modifiers?: readonly ('alt' | 'ctrl' | 'meta' | 'shift')[]
}
\`\`\`

\`BrowserProvider\` 接口(\`type\` 方法后)新增:

\`\`\`ts
  /** Press a key (keyDown + keyUp) into the active tab. Honor \`signal\` for cancellation. */
  pressKey(session: BrowserSessionId, request: BrowserPressKeyRequest, signal?: AbortSignal): Promise<void>
\`\`\`

**runtime.ts:** \`type\` 方法后新增透传:

\`\`\`ts
  /** Press a key into the session's page through the selected provider. */
  async pressKey(session: BrowserSessionId, request: BrowserPressKeyRequest, signal?: AbortSignal): Promise<void> {
    return this.resolveProvider().pressKey(session, request, signal)
  }
\`\`\`

并更新 import 与 export type 列表加入 \`BrowserPressKeyRequest\`。

**provider.ts:** import 增加 \`BrowserPressKeyRequest\`(type list)。模块级新增(在 \`CDP_RUNTIME_EVALUATE\` 常量后):

\`\`\`ts
/** CDP method for keyboard input. */
export const CDP_INPUT_DISPATCH_KEY_EVENT = 'Input.dispatchKeyEvent'

/** Windows virtual-key codes for named keys CDP needs. */
const KEY_VK: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18,
  CapsLock: 20, Escape: 27, Space: 32, PageUp: 33, PageDown: 34,
  End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39,
  ArrowDown: 40, Insert: 45, Delete: 46, Meta: 91,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
}

/** The text a key produces when pressed (null = no text; rawKeyDown). */
function keyText(key: string): string | null {
  switch (key) {
    case 'Enter': return '\r'
    case 'Tab': return '\t'
    case 'Space': return ' '
    default: return /^[a-z0-9]$/i.test(key) ? key : null
  }
}

/** Map a friendly key name to the CDP descriptor. */
function keyDescriptor(key: string): { key: string; code: string; vk: number } {
  const upper = key.toUpperCase()
  if (KEY_VK[key] !== undefined) return { key, code: key, vk: KEY_VK[key] }
  if (/^[a-z]$/i.test(key)) {
    return { key: upper, code: \`Key\${upper}\`, vk: upper.charCodeAt(0) }
  }
  if (/^[0-9]$/.test(key)) {
    return { key, code: \`Digit\${key}\`, vk: key.charCodeAt(0) }
  }
  throw new BrowserError(\`browser: unsupported key "\${key}"\`, 'BROWSER_KEY_UNKNOWN')
}

/** Modifiers as the CDP bitmask: alt=1, ctrl=2, meta=4, shift=8. */
function modifierMask(modifiers: readonly ('alt' | 'ctrl' | 'meta' | 'shift')[] | undefined): number {
  let mask = 0
  for (const mod of modifiers ?? []) {
    if (mod === 'alt') mask |= 1
    else if (mod === 'ctrl') mask |= 2
    else if (mod === 'meta') mask |= 4
    else if (mod === 'shift') mask |= 8
  }
  return mask
}
\`\`\`

类内(\`type\` 方法后)新增:

\`\`\`ts
  /** Press a key into the page (keyDown + keyUp), as a physical-input path
   *  for shortcuts and keyboard-driven UI. */
  async pressKey(session: BrowserSessionId, request: BrowserPressKeyRequest, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, handle)
    const { key, code, vk } = keyDescriptor(request.key)
    const modifiers = modifierMask(request.modifiers)
    const text = keyText(request.key)
    const down: Record<string, unknown> = {
      type: text === null ? 'rawKeyDown' : 'keyDown',
      key, code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers,
    }
    if (text !== null) { down.text = text; down.unmodifiedText = text }
    await handle.sendCommand(CDP_INPUT_DISPATCH_KEY_EVENT, down)
    await handle.sendCommand(CDP_INPUT_DISPATCH_KEY_EVENT, {
      type: 'keyUp', key, code,
      windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      modifiers,
    })
    this.record(s, 'pressKey', {
      key: request.key,
      ...request.modifiers !== undefined && request.modifiers.length > 0 ? { modifiers: request.modifiers } : {},
    }, true)
  }
\`\`\`

**tool-browser/index.ts**(\`browser_type\` 工具注册后)新增:

\`\`\`ts
  ctx.tools.register(defineTool({
    name: 'browser_press_key',
    description: 'Press a key into the focused element of the shared browser (keyDown + keyUp, physical input). Supports single characters, Enter/Tab/Escape/Backspace/Delete, arrow keys, Home/End/PageUp/PageDown, F1-F12, and modifier combos (e.g. key="a" modifiers=["ctrl"] for Ctrl+A). Use after focusing an input or for keyboard navigation.',
    parameters: {
      key: { type: 'string', required: true, description: 'The key to press: a character, Enter, Tab, Escape, ArrowDown, Home, F5, etc.' },
      modifiers: { type: 'array', items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] }, description: 'Modifier keys held during the press.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { pressed: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.pressed ? \`Pressed \${String(_args.key)}.\` : 'Press failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed('browser_press_key')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, taskKey(exec))
      await browser.pressKey(session, {
        key: args.key,
        ...args.modifiers !== undefined ? { modifiers: args.modifiers } : {},
      }, exec.signal)
      return { pressed: true }
    },
  }))
\`\`\`

**测试(provider-actions.test.mjs 追加):**

\`\`\`js
test('pressKey dispatches keyDown and keyUp with CDP key descriptors', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  await provider.pressKey(session, { key: 'Enter' })
  assert.equal(host.log.length, 2)
  assert.equal(host.log[0].method, 'Input.dispatchKeyEvent')
  assert.equal(host.log[0].params.type, 'keyDown')
  assert.equal(host.log[0].params.key, 'Enter')
  assert.equal(host.log[0].params.windowsVirtualKeyCode, 13)
  assert.equal(host.log[0].params.text, '\r')
  assert.equal(host.log[1].params.type, 'keyUp')
  await provider.pressKey(session, { key: 'a', modifiers: ['ctrl'] })
  assert.equal(host.log[2].params.key, 'A')
  assert.equal(host.log[2].params.code, 'KeyA')
  assert.equal(host.log[2].params.modifiers, 2)
  const history = await provider.history(session)
  assert.equal(history[0].action, 'pressKey')
})

test('pressKey rejects unknown keys', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  await assert.rejects(() => provider.pressKey(session, { key: 'Giggles' }), /unsupported key/)
})
\`\`\`

- [ ] **Step 1: 写失败测试** → - [ ] **Step 2: 确认 FAIL** → - [ ] **Step 3: 实现** → - [ ] **Step 4: PASS**(\`npm run build && node --test test/\`,注意 runtime.ts 的 import/export 遗漏会直接类型错误)
- [ ] **Step 5: 部署(provider/tool 改动 → 同步全部 lib + 重启 DSH → 手动:open example.com → browser_execute \`document.querySelector('a').focus()\` → browser_press_key key="Enter" → 快照见导航变化;browser_history 出现 pressKey)**
- [ ] **Step 6: Commit**

\`\`\`bash
git add -A
git commit -m "feat(browser): add browser_press_key with CDP key descriptors"
\`\`\`

---

## Task 3:doubleClick(CDP clickCount:2)

**Files:**
- Modify: \`src/browser/types.ts\`(BrowserDoubleClickRequest、BrowserProvider.doubleClick)
- Modify: \`src/browser/runtime.ts\`
- Modify: \`src/browser-electron/provider.ts\`
- Modify: \`src/tool-browser/index.ts\`
- Modify: \`test/provider-actions.test.mjs\`

**types.ts(在 BrowserPressKeyRequest 后):**

\`\`\`ts
/** Double-click at viewport coordinates (one press/release pair, clickCount 2). */
export interface BrowserDoubleClickRequest {
  /** Viewport-relative x in CSS pixels. */
  readonly x: number
  /** Viewport-relative y in CSS pixels. */
  readonly y: number
}
\`\`\`

\`BrowserProvider\`(\`pressKey\` 后):

\`\`\`ts
  /** Double-click at viewport coordinates. Honor \`signal\` for cancellation. */
  doubleClick(session: BrowserSessionId, request: BrowserDoubleClickRequest, signal?: AbortSignal): Promise<void>
\`\`\`

**runtime.ts** 同构透传 \`doubleClick\`(import/export 均加 \`BrowserDoubleClickRequest\`)。

**provider.ts \`click\` 方法后新增:**

\`\`\`ts
  /** Double-click at viewport coordinates (physical input; clickCount 2). */
  async doubleClick(session: BrowserSessionId, request: BrowserDoubleClickRequest, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, handle)
    await handle.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: request.x, y: request.y, button: 'left', clickCount: 2 })
    await handle.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: request.x, y: request.y, button: 'left', clickCount: 2 })
    this.record(s, 'doubleClick', { x: request.x, y: request.y }, true)
  }
\`\`\`

**tool-browser(在 browser_click 注册后)新增:**

\`\`\`ts
  ctx.tools.register(defineTool({
    name: 'browser_double_click',
    description: 'Double-click at viewport coordinates (CSS pixels) in the shared browser. Use for opening links, selecting text, or expanding UI that ignores single clicks.',
    parameters: {
      x: { type: 'number', required: true, description: 'Viewport x coordinate (CSS px).' },
      y: { type: 'number', required: true, description: 'Viewport y coordinate (CSS px).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { clicked: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.clicked ? 'Double-clicked.' : 'Double-click failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed('browser_double_click')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, taskKey(exec))
      await browser.doubleClick(session, { x: args.x, y: args.y }, exec.signal)
      return { clicked: true }
    },
  }))
\`\`\`

**测试:**

\`\`\`js
test('doubleClick dispatches a clickCount 2 press/release pair', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  await provider.doubleClick(session, { x: 10, y: 20 })
  assert.equal(host.log.length, 2)
  assert.equal(host.log[0].params.type, 'mousePressed')
  assert.equal(host.log[0].params.clickCount, 2)
  assert.equal(host.log[1].params.type, 'mouseReleased')
  assert.equal(host.log[1].params.clickCount, 2)
  assert.equal(host.log[0].params.x, 10)
  const history = await provider.history(session)
  assert.equal(history[0].action, 'doubleClick')
})
\`\`\`

- [ ] Steps 1-4(写/FAIL/实现/PASS;\`npm run build && node --test test/\`)
- [ ] **Step 5: 部署**(同步 provider.js/types.js/runtime.js/tool-browser → 重启 DSH → 手动:文本上双击选中单词或快照取坐标后 browser_double_click 观察行为)
- [ ] **Step 6: Commit**

\`\`\`bash
git add -A
git commit -m "feat(browser): add browser_double_click (clickCount 2)"
\`\`\`

---

## Task 4:hover(CDP mouseMoved)

**Files:**
- Modify: \`src/browser/types.ts\`(BrowserHoverRequest、BrowserProvider.hover)
- Modify: \`src/browser/runtime.ts\`
- Modify: \`src/browser-electron/provider.ts\`
- Modify: \`src/tool-browser/index.ts\`
- Modify: \`test/provider-actions.test.mjs\`

**types.ts(BrowserDoubleClickRequest 后):**

\`\`\`ts
/** Move the pointer to viewport coordinates (no button). */
export interface BrowserHoverRequest {
  /** Viewport-relative x in CSS pixels. */
  readonly x: number
  /** Viewport-relative y in CSS pixels. */
  readonly y: number
}
\`\`\`

\`BrowserProvider\`(\`doubleClick\` 后):\`hover(session, request: BrowserHoverRequest, signal?: AbortSignal): Promise<void>\`

**runtime.ts** 透传。

**provider.ts \`doubleClick\` 后:**

\`\`\`ts
  /** Move the pointer to viewport coordinates (hover; no click). */
  async hover(session: BrowserSessionId, request: BrowserHoverRequest, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, handle)
    await handle.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: request.x, y: request.y, button: 'none' })
    this.record(s, 'hover', { x: request.x, y: request.y }, true)
  }
\`\`\`

**tool-browser(\`browser_double_click\` 后)新增 \`browser_hover\`**(结构同 double_click;parameters x/y;output \`{hovered}\`;描述:"Move the pointer to viewport coordinates (CSS pixels) without clicking. Triggers hover states, tooltips, and dropdown menus";execute 内调 \`browser.hover\`)。

**测试:**

\`\`\`js
test('hover dispatches one mouseMoved with no button', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  await provider.hover(session, { x: 33, y: 44 })
  assert.equal(host.log.length, 1)
  assert.equal(host.log[0].method, 'Input.dispatchMouseEvent')
  assert.equal(host.log[0].params.type, 'mouseMoved')
  assert.equal(host.log[0].params.button, 'none')
  assert.equal(host.log[0].params.x, 33)
})
\`\`\`

- [ ] Steps 1-4; - [ ] Step 5 部署(同步全部 + 重启 DSH → 手动:snapshot 找到导航标签中心坐标 → browser_hover → screenshot 看 hover 态); - [ ] Step 6 Commit \`feat(browser): add browser_hover (mouseMoved)\`。

---

## Task 5:uploadFile(CDP DOM.setFileInputFiles)

**Files:**
- Modify: \`src/browser/types.ts\`(BrowserUploadFileRequest/Result、BrowserProvider.uploadFile)
- Modify: \`src/browser/runtime.ts\`
- Modify: \`src/browser-electron/provider.ts\`
- Modify: \`src/tool-browser/index.ts\`
- Modify: \`test/provider-actions.test.mjs\`

**types.ts(在 BrowserHoverRequest 后):**

\`\`\`ts
/** Set a file input's value from a local path. */
export interface BrowserUploadFileRequest {
  /** Absolute path of the file to attach. */
  readonly filePath: string
  /** CSS selector of the file input; defaults to the first input[type="file"]. */
  readonly selector?: string
}

/** Outcome of a file upload. */
export interface BrowserUploadFileResult {
  /** The path uploaded. */
  readonly path: string
}
\`\`\`

\`BrowserProvider\`(\`hover\` 后):

\`\`\`ts
  /** Attach a local file to a file input. Honor \`signal\` for cancellation. */
  uploadFile(session: BrowserSessionId, request: BrowserUploadFileRequest, signal?: AbortSignal): Promise<BrowserUploadFileResult>
\`\`\`

**runtime.ts** 透传(import/export 加 \`BrowserUploadFileRequest\`、\`BrowserUploadFileResult\`)。

**provider.ts(import 加两个类型;\`hover\` 后新增):**

\`\`\`ts
  /**
   * Attach a local file to the first matching file input. Uses the CDP DOM
   * domain (nodeId path), which — unlike a synthetic change event — makes the
   * input's files list true (real file selection), so pages that read
   * input.files or upload on change behave exactly like a real pick.
   */
  async uploadFile(session: BrowserSessionId, request: BrowserUploadFileRequest, signal?: AbortSignal): Promise<BrowserUploadFileResult> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, handle)
    const selector = request.selector ?? 'input[type="file"]'
    const doc = await handle.sendCommand('DOM.getDocument', {})
    const root = (doc as { root?: { nodeId?: number } }).root
    const rootId = root?.nodeId
    if (rootId === undefined) {
      throw new BrowserError('browser: could not resolve the document node', 'BROWSER_UPLOAD_FAILED')
    }
    const query = await handle.sendCommand('DOM.querySelector', { nodeId: rootId, selector })
    const nodeId = (query as { nodeId?: number }).nodeId
    if (nodeId === undefined || nodeId === 0) {
      throw new BrowserError(\`browser: no file input matches "\${selector}"\`, 'BROWSER_UPLOAD_NO_INPUT')
    }
    await handle.sendCommand('DOM.setFileInputFiles', { files: [request.filePath], nodeId })
    this.record(s, 'uploadFile', { filePath: request.filePath, selector }, true, { result: '1 file attached' })
    return { path: request.filePath }
  }
\`\`\`

**tool-browser(\`browser_hover\` 后)新增:**

\`\`\`ts
  ctx.tools.register(defineTool({
    name: 'browser_upload_file',
    description: 'Attach a local file to a file input in the shared browser (CDP DOM.setFileInputFiles, so the page sees a real file selection). Use for avatar uploads, attachments, and import dialogs.',
    parameters: {
      filePath: { type: 'string', required: true, description: 'Absolute path of the file to attach.' },
      selector: { type: 'string', description: 'CSS selector of the file input; defaults to the first input[type="file"] on the page.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: \`Attached \${value.path}.\` }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed('browser_upload_file')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, taskKey(exec))
      const result = await browser.uploadFile(session, {
        filePath: args.filePath,
        ...args.selector !== undefined ? { selector: args.selector } : {},
      }, exec.signal)
      return { path: result.path }
    },
  }))
\`\`\`

**测试:**

\`\`\`js
test('uploadFile resolves a nodeId through the DOM domain and sets files', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  const result = await provider.uploadFile(session, { filePath: 'C:/tmp/x.txt' })
  assert.equal(result.path, 'C:/tmp/x.txt')
  const getDoc = host.log.find(e => e.method === 'DOM.getDocument')
  assert.ok(getDoc, 'asks for the document')
  const query = host.log.find(e => e.method === 'DOM.querySelector')
  assert.equal(query.params.selector, 'input[type="file"]')
  const set = host.log.find(e => e.method === 'DOM.setFileInputFiles')
  assert.deepEqual(set.params.files, ['C:/tmp/x.txt'])
  assert.equal(set.params.nodeId, 42)
})

test('uploadFile reports a missing file input', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  host.views[0].sendCommand = async (method) => method === 'DOM.querySelector' ? { nodeId: 0 } : {}
  await assert.rejects(() => provider.uploadFile(session, { filePath: 'C:/tmp/x.txt' }), /no file input/)
})
\`\`\`

- [ ] Steps 1-4; - [ ] Step 5 部署(同步全部 + 重启 DSH → 手动:open https://example.com → browser_execute 注入 \`document.body.innerHTML='<input type=file>'; ''\` → browser_upload_file filePath=C:\Windows\win.ini → browser_execute \`document.querySelector('input').files[0]?.name\` 应返回 \`win.ini\`); - [ ] Step 6 Commit \`feat(browser): add browser_upload_file (CDP DOM.setFileInputFiles)\`。

---

## Task 6:waitForElement(轮询 + browser_wait_for 工具)

**Files:**
- Modify: \`src/browser/types.ts\`(BrowserWaitForRequest/Result、BrowserProvider.waitForElement)
- Modify: \`src/browser/runtime.ts\`
- Modify: \`src/browser-electron/provider.ts\`
- Modify: \`src/tool-browser/index.ts\`
- Modify: \`test/provider-actions.test.mjs\`

**types.ts:**

\`\`\`ts
/** Wait for an element matching a CSS selector to appear (optionally visible). */
export interface BrowserWaitForRequest {
  /** CSS selector to wait for. */
  readonly selector: string
  /** Total budget in ms. Default 15000. */
  readonly timeoutMs?: number
  /** Wait for the element to be visible (>4x4 px, not display:none). Default true. */
  readonly visible?: boolean
}

/** Outcome of a successful wait. */
export interface BrowserWaitForResult {
  readonly found: true
  readonly selector: string
  /** Matching element's tag name. */
  readonly tag: string
  /** Matching element's visible text (first 200 chars). */
  readonly text: string
}
\`\`\`

\`BrowserProvider\`(\`uploadFile\` 后):

\`\`\`ts
  /** Wait until an element matching the selector exists (and optionally is visible). Honor \`signal\` for cancellation. */
  waitForElement(session: BrowserSessionId, request: BrowserWaitForRequest, signal?: AbortSignal): Promise<BrowserWaitForResult>
\`\`\`

**runtime.ts** 透传。

**provider.ts(import 加两个类型;\`uploadFile\` 后新增):**

\`\`\`ts
  /**
   * Poll until an element matching the selector exists (and is visible).
   * Bounds the total wait; a timeout surfaces as BROWSER_WAIT_TIMEOUT.
   */
  async waitForElement(session: BrowserSessionId, request: BrowserWaitForRequest, signal?: AbortSignal): Promise<BrowserWaitForResult> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = request.timeoutMs ?? 15_000
    const visible = request.visible !== false
    const selector = request.selector
    const script = \`(() => {
      let el = null
      try { el = document.querySelector(\${JSON.stringify(selector)}) } catch (e) { return { error: String(e) } }
      if (!el) return null
      if (\${visible}) {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        if (r.width < 4 || r.height < 4 || cs.visibility === 'hidden' || cs.display === 'none') return null
      }
      return {
        found: true,
        selector: \${JSON.stringify(selector)},
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      }
    })()\`
    const deadline = Date.now() + timeoutMs
    let lastError: string | undefined
    while (Date.now() <= deadline) {
      signal?.throwIfAborted()
      const result = await handleSendEvaluate(handle, script, signal).catch(error => ({ ok: false, exception: String(error) }))
      if (!result.ok) {
        lastError = result.exception
      } else {
        const value = result.value as { found?: boolean; tag?: string; text?: string; error?: string } | null
        if (value?.found === true && typeof value.tag === 'string') {
          this.record(s, 'waitForElement', { selector, timeoutMs, visible }, true, { result: value.tag })
          return { found: true, selector, tag: value.tag, text: value.text ?? '' }
        }
        if (value?.error !== undefined) lastError = value.error
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new BrowserError(\`browser: element "\${selector}" did not appear within \${timeoutMs}ms\${lastError !== undefined ? \` (\${lastError})\` : ''}\`, 'BROWSER_WAIT_TIMEOUT')
  }
\`\`\`

**tool-browser(在 browser_upload_file 注册后)新增:**

\`\`\`ts
  ctx.tools.register(defineTool({
    name: 'browser_wait_for',
    description: 'Wait until an element matching a CSS selector appears (and is visible), polling every 250ms. Use before interacting with dynamically-loaded content (SPA views, toasts, menus).',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector to wait for.' },
      timeoutMs: { type: 'number', description: 'Total budget in ms (default 15000).' },
      visible: { type: 'boolean', description: 'Require visibility (>4x4 px, not display:none). Default true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          selector: { type: 'string', required: true },
          tag: { type: 'string', required: true },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: \`Found <\${value.tag}> \${value.selector}\${value.text !== undefined ? \` — "\${value.text.slice(0, 80)}"\` : ''}.\` }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertAllowed('browser_wait_for')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, taskKey(exec))
      const result = await browser.waitForElement(session, {
        selector: args.selector,
        ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
        ...args.visible !== undefined ? { visible: args.visible } : {},
      }, exec.signal)
      return { found: true, selector: result.selector, tag: result.tag, text: result.text }
    },
  }))
\`\`\`

**测试:**

\`\`\`js
test('waitForElement polls until the element appears', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  // 前两次 evaluate 返回 null,第三次返回 found
  host.evalReplies.push(
    { result: { value: null } },
    { result: { value: null } },
    { result: { value: { found: true, selector: '#go', tag: 'button', text: 'Go' } } },
  )
  const result = await provider.waitForElement(session, { selector: '#go', timeoutMs: 3000 })
  assert.equal(result.found, true)
  assert.equal(result.tag, 'button')
  assert.equal(host.log.filter(e => e.method === 'Runtime.evaluate').length, 3)
  const history = await provider.history(session)
  assert.equal(history[0].action, 'waitForElement')
})

test('waitForElement times out with BROWSER_WAIT_TIMEOUT', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  host.evalReplies.push({ result: { value: null } })
  await assert.rejects(
    () => provider.waitForElement(session, { selector: '#never', timeoutMs: 600 }),
    (error) => error.code === 'BROWSER_WAIT_TIMEOUT',
  )
})
\`\`\`

- [ ] Steps 1-4; - [ ] Step 5 部署(同步全部 + 重启 DSH → 手动:open https://www.iana.org 后 \`browser_wait_for selector="a[href]"\` 立即命中;再执行 \`browser_execute\` 注入延时元素后 waitForElement 1.5s 命中); - [ ] Step 6 Commit \`feat(browser): add browser_wait_for with bounded polling\`。

---

## Task 7:快照 locator 输出

**Files:**
- Modify: \`src/browser-electron/provider.ts\`(snapshot 脚本加 locatorOf + loc 字段)
- Modify: \`src/browser/types.ts\`(BrowserSnapshotElement 加 loc)
- Modify: \`src/tool-browser/index.ts\`(schema + formatSnapshot 显示 loc)
- Modify: \`test/host-composition.test.mjs\`(源码断言)

**provider.ts snapshot 脚本改动:** \`out.push({...})\` 处把 \`selector:\` 表达式后增加 \`loc: locatorOf(el),\`;并在 snapshot 脚本字符串内、\`const cap = ...\` 之后插入 helper:

\`\`\`ts
      const locatorOf = (el) => {
        if (el.id) return '#' + CSS.escape(el.id)
        if (el.name) return '[name=' + JSON.stringify(el.name) + ']'
        const aria = el.getAttribute('aria-label')
        if (aria) return '[aria-label=' + JSON.stringify(aria) + ']'
        const tag = el.tagName.toLowerCase()
        const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30)
        if (text) return tag + ':has-text("' + text.replace(/"/g, '\\\\"') + '")'
        return tag
      }
\`\`\`

**types.ts:** \`BrowserSnapshotElement\` 接口(\`selector\` 行后)新增:

\`\`\`ts
  /** Best-effort locator for re-targeting (id/name/aria-label/text). */
  readonly loc: string
\`\`\`

**tool-browser/index.ts:**
- \`browser_open\` 与 \`browser_snapshot\` 的 elements item schema(\`properties\` 中 \`selector\` 行后)加:

\`\`\`ts
                loc: { type: 'string', required: true },
\`\`\`

- 两处 \`.map(el => ({ ref: el.ref, kind: el.kind, label: el.label, x: el.x, y: el.y }))\` 改为:

\`\`\`ts
        .map(el => ({ ref: el.ref, kind: el.kind, label: el.label, x: el.x, y: el.y, loc: el.loc })),
\`\`\`

- \`formatSnapshot\` 的行模板改为:

\`\`\`ts
  const lines = snapshot.elements.map(el => \`[\${el.ref}] \${el.kind}: \${el.label} (\${el.x},\${el.y}) loc=\${el.loc}\`)
\`\`\`

并在 \`formatSnapshot\` 的入参类型里 elements 元素类型补上 \`loc: string\`。

**测试(host-composition.test.mjs 追加):**

\`\`\`js
test('snapshots emit a targeted locator per element', async () => {
  const source = await readFile(providerPath, 'utf8')
  assert.match(source, /const locatorOf = /)
  assert.match(source, /CSS\.escape/)
  assert.match(source, /loc: locatorOf\(el\)/)
})
\`\`\`

- [ ] Steps 1-4(\`npm run build && node --test test/\`;\`formatSnapshot\` 类型收紧后所有调用点编译期即可暴露); - [ ] Step 5 部署(同步 provider.js/types.js/tool-browser → 重启 DSH → 手动 \`browser_snapshot\` 输出每行含 \`loc=\`); - [ ] Step 6 Commit \`feat(browser): emit locator for every snapshot element\`。

---

## Task 8:每会话独立窗口(host 多窗口 + seam 签名)

**Files:**
- Modify: \`src/browser-electron/host-main.ts\`(windowsByKey + windowFor + HostView 带窗口 + layoutWindow + showView/capture 窗口化;createView 接 \`key\`/\`label\`;新增 \`label\`/\`listWindows\` op)
- Modify: \`src/browser-electron/remote-host.ts\`(createView(key,label);RemoteView.label;listWindows)
- Modify: \`src/browser-electron/provider.ts\`(ElectronBrowserViewHost.createView 签名;open(options))
- Modify: \`src/browser/types.ts\`(BrowserOpenOptions;BrowserProvider.open(options))
- Modify: \`src/browser/runtime.ts\`(open 透传 options)
- Modify: \`src/types/electron-shim.d.ts\`(BrowserWindow.setTitle/isDestroyed)
- Modify: \`test/host-composition.test.mjs\`
- Modify: \`test/provider-actions.test.mjs\`

**host-main 改动(核心):**

1. \`HostView\` 接口改为:

\`\`\`ts
interface HostView {
  readonly webContentsView: WebContentsView
  /** The window this view lives in (one per session key). */
  readonly window: BrowserWindow
  /** The window group key the view belongs to. */
  readonly windowKey: string
}
\`\`\`

2. 窗口管理(替换 \`let window: BrowserWindow | undefined\`):

\`\`\`ts
/** Default window (key 'default'), created lazily. */
let defaultWindow: BrowserWindow | undefined
/** Per-session windows by their key. */
const windowsByKey = new Map<string, BrowserWindow>()
/** Most recent label per window key (for listWindows). */
const windowLabels = new Map<string, string>()

function makeWindow(title: string): BrowserWindow {
  const win = new BrowserWindow({ width: 1400, height: 900, show: true, title })
  win.setMenu(null)
  win.on('resize', () => layoutWindow(win))
  return win
}

function windowFor(key: string, label?: string): BrowserWindow {
  if (key === 'default') {
    if (defaultWindow === undefined) defaultWindow = makeWindow(label !== undefined ? \`dsh-browser — \${label}\` : 'dsh-browser')
    return defaultWindow
  }
  let win = windowsByKey.get(key)
  if (win === undefined) {
    win = makeWindow(label !== undefined ? \`dsh-browser — \${label}\` : 'dsh-browser')
    windowsByKey.set(key, win)
    win.on('closed', () => { windowsByKey.delete(key); windowLabels.delete(key) })
  }
  return win
}
\`\`\`

3. \`layoutPageViews()\` 替换为窗口级:

\`\`\`ts
/** Keep all views of one window aligned with its content surface. */
function layoutWindow(win: BrowserWindow): void {
  const [width, height] = win.getContentSize()
  for (const entry of views.values()) {
    if (entry.window !== win) continue
    try {
      entry.webContentsView.setBounds({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 })
    } catch { /* destroyed */ }
  }
}
\`\`\`

4. \`createView\` case 的 message 类型加 \`key?\`/\`label?\`,并删除旧 \`if (window === undefined) { ... }\` 块,代之以(在 \`const view = new WebContentsView()\` 之前):

\`\`\`ts
        const windowKey = typeof msg.key === 'string' ? msg.key : 'default'
        const label = typeof msg.label === 'string' ? msg.label : undefined
        const win = windowFor(windowKey, label)
\`\`\`

5. \`window.contentView.addChildView(view)\` 改为 \`win.contentView.addChildView(view)\`;\`views.set(viewId, { webContentsView: view })\` 改为 \`views.set(viewId, { webContentsView: view, window: win, windowKey })\`;\`layoutPageViews()\` 调用改为 \`layoutWindow(win)\`。

6. \`showView\` case 加同窗口过滤:

\`\`\`ts
          for (const v of views.values()) {
            if (v === entry || v.window !== entry.window) continue
            try { v.webContentsView.setVisible(false) } catch { /* destroyed */ }
          }
\`\`\`

7. \`capture\` case 中 \`window\` 全部改为 \`entry.window\`(show/restore/focus 与状态诊断)。同时 \`destroyView\` case 中 \`window?.contentView.removeChildView(...)\` 改为 \`entry.window.contentView.removeChildView(...)\`。

8. 新增 op(\`case 'showView'\` 之后、\`case 'command'\` 之前):

\`\`\`ts
      case 'label': {
        const viewId = msg.viewId
        const label = msg.label
        if (viewId === undefined || typeof label !== 'string') throw new Error('label missing viewId/label')
        const entry = views.get(viewId)
        if (entry === undefined) throw new Error(\`label: unknown view \${viewId}\`)
        try { entry.window.setTitle(\`dsh-browser — \${label}\`) } catch { /* closing */ }
        windowLabels.set(entry.windowKey, label)
        reply(msg.id, { ok: true })
        return
      }
      case 'listWindows': {
        const windows: Array<{ key: string; label: string }> = []
        if (defaultWindow !== undefined) windows.push({ key: 'default', label: windowLabels.get('default') ?? '' })
        for (const [key, win] of windowsByKey) {
          if (!win.isDestroyed()) windows.push({ key, label: windowLabels.get(key) ?? '' })
        }
        reply(msg.id, { ok: true, result: { windows } })
        return
      }
\`\`\`

**electron-shim.d.ts \`BrowserWindow\` 接口新增:**

\`\`\`ts
    setTitle(title: string): void
    isDestroyed(): boolean
\`\`\`

**remote-host.ts:**

- \`RemoteElectronViewHost.createView\` 改为:

\`\`\`ts
  createView(key?: string, label?: string): ElectronViewHandle {
    // The seam is synchronous; the provider uses the handle immediately, so
    // commands are deferred until the child is up and the view materialized.
    const id = \`view:\${Math.random().toString(36).slice(2, 10)}\`
    const view = new DeferredRemoteView(id, () => this.ensureView(id, key, label))
    this.views.set(id, view)
    return view
  }
\`\`\`

- \`ensureView\` 加参数:

\`\`\`ts
  private async ensureView(id: string, key?: string, label?: string): Promise<RemoteView> {
    await this.ready()
    const client = this.client
    if (client === undefined) throw new Error('browser host unavailable')
    await client.call('createView', {
      viewId: id,
      ...key !== undefined ? { key } : {},
      ...label !== undefined ? { label } : {},
    })
    // If the view was destroyed while the createView RPC was in flight, do
    // not re-insert a stale entry that would resurrect a dead child view.
    if (this.views.get(id) === undefined) {
      throw new Error('browser: view destroyed while starting')
    }
    const view = new RemoteView(id, client)
    this.views.set(id, view)
    return view
  }
\`\`\`

- \`RemoteView\` 增加:

\`\`\`ts
  /** Set the window title (space name) for this view's window. */
  async label(label: string): Promise<void> {
    await this.client.call('label', { viewId: this.id, label })
  }

  /** List all open window keys with their labels (host-level). */
  async listWindows(): Promise<Array<{ key: string; label: string }>> {
    const r = await this.client.call<{ windows: Array<{ key: string; label: string }> }>('listWindows')
    return r.windows
  }
\`\`\`

- \`DeferredRemoteView\` 转发 \`label\`(materializeOnce 后调用):

\`\`\`ts
  async label(label: string): Promise<void> {
    const view = await this.materializeOnce()
    return view.label(label)
  }
\`\`\`

**provider.ts:**

\`ElectronBrowserViewHost.createView\` 签名改为:

\`\`\`ts
  /**
   * Create a new browser view and return a handle to its webContents-like
   * surface. \`key\` (default 'default') picks the window group — each key gets
   * its own BrowserWindow; \`label\` names the window (space name).
   */
  createView(key?: string, label?: string): ElectronViewHandle
\`\`\`

\`open\` 改为(import 增加 \`BrowserOpenOptions\`):

\`\`\`ts
  open(options?: BrowserOpenOptions): Promise<BrowserSessionId> {
    const handle = this.host.createView(options?.key ?? 'default', options?.label)
    const id = \`browser:\${randomUUID()}\`
    this.sessions.set(id, { id, tabs: [{ id: \`tab:\${randomUUID()}\`, handle }], activeIndex: 0, history: [], nextSeq: 1 })
    return Promise.resolve(id)
  }
\`\`\`

**types.ts:**

\`\`\`ts
/** Options for opening a new browser session. */
export interface BrowserOpenOptions {
  /** Window group key; each distinct key gets its own window. Default 'default'. */
  readonly key?: string
  /** Label (space name) shown in the window title. */
  readonly label?: string
}
\`\`\`

\`BrowserProvider.open\` 签名改为 \`open(options?: BrowserOpenOptions): Promise<BrowserSessionId>\`。

**runtime.ts \`open\` 改为:**

\`\`\`ts
  async open(options?: BrowserOpenOptions): Promise<BrowserSessionId> {
    return this.resolveProvider().open(options)
  }
\`\`\`

import/export 类型列表加 \`BrowserOpenOptions\`。

**测试(host-composition.test.mjs 追加):**

\`\`\`js
test('host keeps one window per session key and labels them', async () => {
  const source = await readFile(hostPath, 'utf8')
  assert.match(source, /windowsByKey/)
  assert.match(source, /windowFor\(/)
  assert.match(source, /case 'label'/)
  assert.match(source, /case 'listWindows'/)
  assert.match(source, /dsh-browser — /)
  assert.match(source, /v\.window !== entry\.window/)
  assert.ok(!source.includes('layoutPageViews()'), 'window-scoped layout only')
})

test('provider opens with a window key and label through the host seam', async () => {
  const source = await readFile(providerPath, 'utf8')
  assert.match(source, /createView\(options\?\.key/)
})

test('remote host forwards createView key/label and window ops', async () => {
  const source = await readFile(remotePath, 'utf8')
  assert.ok(source.includes("call('createView'"), 'creates views')
  assert.match(source, /\.\.\.key !== undefined/)
  assert.ok(source.includes("call('label'"), 'labels windows')
  assert.ok(source.includes("call('listWindows'"), 'lists windows')
})
\`\`\`

**provider-actions.test.mjs 追加:**

\`\`\`js
test('open forwards a window key and label to the host', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  await provider.open({ key: 'task-1', label: 'rewards' })
  assert.deepEqual(host.createViewArgs[0], { key: 'task-1', label: 'rewards' })
  await provider.open()
  assert.deepEqual(host.createViewArgs[1], { key: 'default', label: undefined })
})
\`\`\`

- [ ] Steps 1-4(注意:此任务改动面大,先跑 \`npm run build\` 修类型,再 \`node --test test/\`);
- [ ] **Step 5: 部署安全渐变**(同步 host-main.js/remote-host.js/provider.js/types.js/runtime.js → 回收 child + 重启 DSH → 手动:本会话 \`browser_open https://example.com\` 出现单个窗口(默认组);在另一个 DSH 会话开浏览器 → 出现**第二个独立窗口**,两窗口互不遮挡切换;**绝密检查**:每个窗口内有且仅有一个视图,无白屏 → 若白屏立即回滚 host-main 上一版并记录);
- [ ] **Step 6: Commit**

\`\`\`bash
git add -A
git commit -m "feat(browser): one BrowserWindow per session key"
\`\`\`

---

## Task 9:space 命名(窗口标题 + browser_space 工具)

**Files:**
- Modify: \`src/browser/types.ts\`(BrowserSpaceInfo;BrowserProvider.setSpace/listSpaces)
- Modify: \`src/browser/runtime.ts\`
- Modify: \`src/browser-electron/provider.ts\`(setSpace/listSpaces 实现,ElectronViewHandle 加 \`label?\`、host seam 加 \`listWindows?\`)
- Modify: \`src/tool-browser/index.ts\`(ensureSession 传 key/label;browser_open 加 space 参数;browser_space 工具)
- Modify: \`test/provider-actions.test.mjs\`

**types.ts:**

\`\`\`ts
/** One open browser window (space). */
export interface BrowserSpaceInfo {
  /** Window group key. */
  readonly key: string
  /** Display label, or '' for unlabeled. */
  readonly label: string
}
\`\`\`

\`BrowserProvider\`(在 \`close\` 声明之前)新增:

\`\`\`ts
  /** Set the space (window title) for a session. */
  setSpace(session: BrowserSessionId, label: string): Promise<void>
  /** List every open window (space) with its label. */
  listSpaces(): Promise<readonly BrowserSpaceInfo[]>
\`\`\`

**runtime.ts** 透传 \`setSpace\` / \`listSpaces\`(import/export 加 \`BrowserSpaceInfo\`)。

**provider.ts:**

- \`ElectronViewHandle\` 增加:

\`\`\`ts
  /** Set the window title (space name) for this view's window. Optional. */
  label?(label: string): Promise<void>
\`\`\`

- \`ElectronBrowserViewHost\` 增加:

\`\`\`ts
  /** List open windows with their labels. Optional (self-hosted only). */
  listWindows?(): Promise<Array<{ key: string; label: string }>>
\`\`\`

- import 加 \`BrowserSpaceInfo\`。

- \`ElectronBrowserProvider\` 类新增(\`record\` 之前):

\`\`\`ts
  /** Name this session's window (space). */
  async setSpace(session: BrowserSessionId, label: string): Promise<void> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    const labelable = handle as { label?(label: string): Promise<void> }
    if (typeof labelable.label === 'function') {
      await labelable.label(label)
    } else {
      throw new BrowserError('browser: space naming is only available on the self-hosted browser', 'BROWSER_SPACE_UNSUPPORTED')
    }
    this.record(s, 'setSpace', { label }, true)
  }

  /** List every open window (space) with its label. */
  async listSpaces(): Promise<readonly BrowserSpaceInfo[]> {
    const host = this.host as { listWindows?(): Promise<Array<{ key: string; label: string }>> }
    if (typeof host.listWindows !== 'function') return []
    return host.listWindows()
  }
\`\`\`

**tool-browser/index.ts:**

- \`ensureSession\` 签名与实现改为:

\`\`\`ts
async function ensureSession(browser: NonNullable<Context['browser']>, key: string, label?: string): Promise<BrowserSessionId> {
  const existing = sessionsByTask.get(key)
  if (existing !== undefined) return existing
  const pending = pendingOpens.get(key)
  if (pending !== undefined) return pending
  const opening = browser.open({
    key,
    ...label !== undefined && label !== '' ? { label } : {},
  }).then(
    session => { sessionsByTask.set(key, session); pendingOpens.delete(key); return session },
    error => { pendingOpens.delete(key); throw error },
  )
  pendingOpens.set(key, opening)
  return opening
}
\`\`\`

- \`browser_open\` 参数加 \`space\`:

\`\`\`ts
      space: { type: 'string', description: 'Optional space name shown in the window title (per-task windows are created automatically).' },
\`\`\`

execute 内:

\`\`\`ts
      const session = await ensureSession(browser, taskKey(exec), args.space)
\`\`\`

(其余浏览器工具保持 \`ensureSession(browser, taskKey(exec))\`;首开无 space 则窗口无标签,后续 \`browser_space\` 补充命名。)

- 新增工具(放在 \`browser_open\` 注册之后):

\`\`\`ts
  ctx.tools.register(defineTool({
    name: 'browser_space',
    description: 'Name this task\'s browser window (space) or list every open window. Pass label="rewards task" to rename the current task\'s window title; pass no label to list spaces. Each task gets its own window, so naming tells the human which agent owns which window.',
    parameters: {
      label: { type: 'string', description: 'New space name for this task\'s window. Omit to list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          spaces: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                label: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.label !== undefined) return [{ type: 'text', text: \`Space named "\${value.label}".\` }]
        const spaces = value.spaces as Array<{ key: string; label: string }>
        const lines = spaces.length === 0 ? '(no windows open)' : spaces.map(s => \`\${s.key}\${s.label !== '' ? \` — \${s.label}\` : ''}\`).join('\n')
        return [{ type: 'text', text: \`Open spaces:\n\${lines}\` }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, taskKey(exec))
      if (args.label !== undefined) {
        await browser.setSpace(session, args.label)
        return { label: args.label }
      }
      const spaces = await browser.listSpaces()
      return { spaces: spaces.map(s => ({ key: s.key, label: s.label ?? '' })) }
    },
  }))
\`\`\`

**测试(provider-actions.test.mjs 追加):**

\`\`\`js
test('setSpace labels the window and records it', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  const handle = host.views[0]
  let labeled = null
  handle.label = async (label) => { labeled = label }
  await provider.setSpace(session, 'rewards')
  assert.equal(labeled, 'rewards')
  const history = await provider.history(session)
  assert.equal(history[0].action, 'setSpace')
})

test('listSpaces forwards to the host', async () => {
  const host = new FakeHost()
  host.listWindows = async () => [{ key: 'task-1', label: 'rewards' }]
  const provider = new ElectronBrowserProvider(host)
  const spaces = await provider.listSpaces()
  assert.deepEqual(spaces, [{ key: 'task-1', label: 'rewards' }])
})
\`\`\`

- [ ] Steps 1-4; - [ ] Step 5 部署(同步全部 + 重启 DSH → 手动:\`browser_space label="奖励任务"\` → 窗口标题变为 \`dsh-browser — 奖励任务\`;\`browser_space\`(无参)列出该窗口;browser_history 出现 setSpace); - [ ] Step 6 Commit \`feat(browser): add browser_space naming and window listing\`。

---

## Task 10:全量回归、文档与发布准备

**Files:**
- Modify: \`README.md\` / \`README.en.md\`(补充新工具清单与 per-task windows 说明)
- Modify: \`package.json\`(version 0.2.0 → 0.3.0)

- [ ] **Step 1: 全量验证**

\`\`\`powershell
npm run build
node --test test/
git status   # 应无未提交
\`\`\`

Expected:\`# pass\` 覆盖全部测试(原 12 + 本计划新增约 14 ≈ 26),0 fail。

- [ ] **Step 2: 手动浸泡回归(每项都要做)**

1. \`browser_open https://example.com\` → 工具栏完整(后退/前进/刷新/停止/主页/书签/trail)且无白屏。
2. 连续导航 5 个站点(example.com → bing.com → w3.org → iana.org → example.com)→ 无白屏、无第二视图。
3. \`browser_press_key\`/\`browser_double_click\`/\`browser_hover\`/\`browser_upload_file\` 各跑一遍。
4. \`browser_wait_for\` + 动态元素;\`browser_snapshot\` 出 \`loc=\`。
5. \`browser_execute\` 触发 confirm → 页面不卡 + history 有 dialog。
6. 另一 DSH 会话 \`browser_open\` → 出现第二窗口;\`browser_space\` 两窗口互不影响。
7. 回收 Electron child 后下一次调用自动重启(无残留窗口)。
8. **白屏探测**:若出现任何白屏 → 立即停,回滚 host-main 到上一提交,重新浸泡(白屏 = 违反铁律 1/2/3)。

- [ ] **Step 3: 版本与文档**

\`\`\`powershell
# package.json version -> 0.3.0 后
npm run build
\`\`\`

README 工具清单补:\`browser_press_key\`、\`browser_double_click\`、\`browser_hover\`、\`browser_upload_file\`、\`browser_wait_for\`、\`browser_space\`;新增节 "Per-task windows & spaces: 每个 DSH 任务一个浏览器窗口,窗口标题即 space 名"。

- [ ] **Step 4: Commit**

\`\`\`bash
git add -A
git commit -m "release: v0.3.0 — ego-tier input, wait, locator, and per-session windows"
git tag v0.3.0
\`\`\`

- [ ] **Step 5: 发布前检查(交给独立发布任务,不在本计划内)**

\`repository.url\` 占位符替换、live 换名安装 \`dsh-browser-plus\`(cookie 走 browser_auth export/import 迁移)、GitHub 建仓 + \`dsh-plugin\` topic + awesome-dsh-plugin 收录。

---

## Self-Review 记录

**覆盖对照:**
- dialog 处理 → Task 1(自动 accept + drain 记录)✓
- pressKey → Task 2 ✓;doubleClick → Task 3 ✓;hover → Task 4 ✓;uploadFile → Task 5 ✓
- waitForElement → Task 6 ✓;locator 输出 → Task 7 ✓
- space 命名/GUI → Task 9(窗口标题 = GUI + browser_space);per-session windows → Task 8 ✓
- 部署/回收/重启级别 → 每任务 Step 5 逐条给出 ✓
- 铁律(不 reparent/不双视图/Electron 42/唯一 id/过滤 chrome/断言避 id 字面) → Phase 0 + Task 8 手动验证 1-2 ✓

**占位符扫描:** 无 TBD/TODO;每个实现步骤含完整代码;手动验证步骤含具体 URL/命令。Task 5 的手动验证用注入 \`<input type=file>\` 的方式规避 httpOnly 拦截,已写明。

**类型一致性:** \`BrowserOpenOptions\`(Task 8)被 Task 9 复用;\`ElectronViewHandle.label?\` / \`host.listWindows?\`(Task 9)由 Task 8 的 op 支撑;\`createView(key,label)\`(Task 8)在 provider.open(Task 8)与 tool 层 ensureSession(Task 9)一致;\`clearDialog\`(Task 1)在 handle 与 RemoteView/DeferredRemoteView 双处实现;record action 名 \`dialog\`/\`pressKey\`/\`doubleClick\`/\`hover\`/\`uploadFile\`/\`waitForElement\`/\`setSpace\` 均为小写驼峰,与现有 \`navigate\`/\`click\`/\`type\`/\`fill\` 风格一致。

**风险提示:** Task 8 是唯一涉及窗口模型的大改——逐项按本计划顺序执行,勿合并 Task 8/9 同时上;每步 commit 保留回滚点。