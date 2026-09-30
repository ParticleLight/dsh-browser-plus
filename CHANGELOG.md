# Changelog

## Unreleased

- **`browser_restrict` 改为按任务隔离**:此前白名单是模块级全局状态,一个任务设置后会把**所有**并行任务的浏览器工具一起限制。现在规则按调用任务存储,插件级 `tool-browser.allowedActions` 作为默认值,单个任务可用空列表只为解除自己。
- **页面可见轨迹脱敏**:注入页面的 `window.__dshChromeBootstrap.trail` 只保留展示所需字段——`type` 折叠为字符数、`execute` 丢弃脚本、URL 折叠为 origin、路径折叠为 basename。此前被访问页面可用一行 JS 读走同任务中早前站点输入的文本(含密码)与执行过的脚本。
- **页面→宿主控制通道加每视图 token**:`__dshBrowserTaskAction` 的 payload 必须携带 `createView` 生成的随机 token。此前任意页面脚本可伪造 `set-control-owner=human` 冻结该任务的 Agent 自动化。残留风险:页面若在 chrome 注入前 hook `JSON.stringify` 仍可能窃取 token,彻底解法是 isolated world 注入(后续工作)。
- **读操作纳入每任务 FIFO**:`snapshot`/`content`/`screenshot`/`list_tabs`/`history`/`session`/`space(list)` 现在会等待在飞写操作,修复并发 `browser_open` + `browser_snapshot` 读到导航前页面的竞态;同 readKey 的 in-flight 去重保留,`operationTails` 改为队列空闲即回收。
- **主机自愈改用稳定错误码**:新增 `BROWSER_HOST_DEAD` 与 `isBrowserHostDead()`;子进程在**调用中途**崩溃(exit / spawn error / socket close / 缓冲溢出 / RPC 超时)现在与"先崩再调"一样自愈一次,不再依赖错误文案匹配。disposed 之后不再重启子进程。
- **`available()` 实检**:`ElectronBrowserViewHost` 新增可选 `isAvailable?()`;自托管 host 落地实现(带缓存),Electron 缺失时如实上报不可用,seam 的 provider 选择错误码得以真正生效。
- **markdown 抓取修复**:`browser_content format=markdown` 的 walker 现在递归块级容器,标题/链接/列表在常见 `div` 嵌套下不再退化成纯文本。
- **下载内存**:子进程下载上限 256MiB → 64MiB,父进程 RPC 缓冲 512MiB → 128MiB(按 base64 推导保留 1.5× 余量)。
- **`browser_upload_file`**:补 30s 超时与 Agent 输入抑制标记,与其它输入工具一致。
- **`internals`**:标注 `@internal`;因 `lib/tool-browser/index.d.ts` 仍会导出,未真正移出公共 API 面(后续)。
- **写入路径白名单**:`browser_screenshot` 与 `browser_download` 只能写入 `browser-electron.writeRoots`(默认工作目录 + 系统临时目录)之内的路径;越界抛出 `BROWSER_WRITE_PATH_DENIED` 且不落盘。路径解析会处理最深已存在祖先的真实路径,防 `..` 与符号链接逃逸。
- **下载共用导航准入**:`browser_download` 与 `browser_navigate` 走同一套 URL 准入(仅 HTTP(S),拒绝 URL 内嵌凭据),不再绕过 `httpOnly`。
- **测试可信度**:`npm test` 现在先执行 `tsc`(`pretest`),不再对可能过期的构建产物 `lib/` 做假绿测试;快速迭代可用 `npm run test:only`。
## v0.4.2 (2026-09-17)

- **按站点清理 Cookie**: `browser_auth action="clear"` 支持按 `domain`(含子域)与/或 `name` 精确删除 Cookie;未限定范围时必须显式 `all: true`,避免误清全部登录态。用于清理 WAF 轮换名称留下的旧代挑战 Cookie。

## v0.4.1 (2026-08-26)

- **多标签会话恢复**: keyed browser sessions are recovered when the tool-layer session cache is lost, so the first direct switch or close operation still targets the existing tabs.

## v0.4.0 (2026-08-26)

- **显式人机交接**: 任务卡显示运行、等待用户、用户接管、失败和空闲状态；用户可在页面中接管/交还任务，`browser_tasks` 与 `browser_handoff` 暴露同一状态。
- **语义浏览控制**: 新增后退、前进、刷新、停止、滚动，以及由 `snapshotId` 和元素 ref 驱动的精确点击/滚动到元素工具。
- **轻量工作区同步**: Host 改为 bootstrap + versioned patch；常规操作只更新一张任务卡和一条轨迹。
- **资源预算**: 任务缩略图仅在任务面板打开时按需单飞捕获，带 2 秒节流和 32 项缓存；后台页面停止地址栏和用户活动轮询。
- **低干扰工具栏**: 工具栏默认隐入页面上方，顶部中间悬停出现圆形下箭头；展开后最右侧上箭头可收起工具栏及其关联浮层。

## v0.3.1 (2026-08-23)

- **单窗口任务管理器**: 所有 DSH 任务共享一个可见浏览器窗口，同时保留隔离的任务视图、标签和历史；页面任务管理器切换可见任务，后台任务操作不会抢走当前页面。
- **任务标签**: `browser_space` 命名或列出浏览器任务，不再表示原生窗口；任务标签显示在任务管理器和活动窗口标题。
- **可视工作区**: 任务与操作轨迹可同时打开，切换任务同步轨迹，并显示可见页面的实时缩略图。
- **Browser Flow 图标**: 新增 SVG 主源、PNG/ICO 衍生资源及 Electron 窗口图标接入。

## v0.3.0 (2026-08-21)

Ego 级功能集:

- **JS 对话框**:宿主自动 accept(页面永不卡死),草案以 `drainDialog` 读回并写入 `browser_history`(`dialog` 记录)。
- **输入工具**:`browser_press_key`(CDP keyDown/keyUp,修饰键位掩码)、`browser_double_click`(clickCount 2)、`browser_hover`(mouseMoved)、`browser_upload_file`(DOM.setFileInputFiles 真实文件选择)。
- **等待与定位**:`browser_wait_for`(250ms 有界轮询,`BROWSER_WAIT_TIMEOUT`);快照每个元素输出 `loc=`(id/name/aria-label/text 定位链)。
- **每任务窗口**:每个 DSH 任务一个独立 `BrowserWindow`(createView key);`browser_space` 命名窗口标题并列出全部窗口。
- **稳定性**:Electron 锁定 42.9.3(43.4.1 组合器故障);capture CDP 回退仅 detach 同窗口视图;截断/挂起防护(per-poll 超时)。
- **质量**:32/32 测试(FakeHost 行为测试 12 条 + 源码断言/页面 chrome 断言);SDD 全流程评审(每任务 implement->review->fix 循环 + 整支 final review)。

## v0.2.0 (2026-08-21)

首版 `dsh-browser-plus`:共享可见浏览器、ego 风格页面内工具栏、操作轨迹(trail)面板、用户控制检测、稳定单视图合成。
