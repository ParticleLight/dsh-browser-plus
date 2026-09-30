# Changelog

## v0.4.3 (2026-09-30)

- **`browser_fill` 不再静默假成功**:checkbox/radio 点击后回读 `checked`,未变更(disabled 或被处理器取消)报 `ok:false`;input/textarea 在请求了非空值却得到空值时报错;`submit` 改为锚定**实际填入成功**的最后一个字段所在表单(此前取第一个能解析到的字段),并在 `requestSubmit()` 因 HTML5 约束校验不通过而**不提交**时如实返回 `submitted:false`(此前一律报 true)。
- **`browser_content format=json` 不再恒返回 `{}`**:DOM 元素没有自有可枚举属性,`JSON.stringify(document.body)` 永远是 `{}`。现在返回有界的结构视图(标签/id/class/子节点/叶子文本),若文本本身就是 JSON 则原样透传。
- **`browser_press_key` 支持标点**:此前只认字母数字与功能键,`Ctrl+-`、`Ctrl+/`、`,`、`.`、`[`、`]` 等一律抛 `BROWSER_KEY_UNKNOWN`,而工具描述却写「single characters」。现在按 US 布局补全可打印 ASCII。
- **`browser_wait_for` 非法选择器快速失败**:此前会每 250ms 重试直到超时(默认 15s)再报一个误导性的 `BROWSER_WAIT_TIMEOUT`,现在立即抛 `BROWSER_SELECTOR_INVALID`。
- **工具栏不再吞掉代理点击**:注入 chrome 的顶部中央 280×56 感应区在捕获阶段 `preventDefault` + `stopImmediatePropagation`,且从不检查 Agent 输入抑制窗口,导致落在该带的 CDP 点击到不了页面、`browser_click` 却报成功;抽屉打开后无自动关闭,死区还会扩大到约 940×42。现在感应与触发都会在 Agent 输入期间让路。
- **缩略图失败不再 5Hz 重试**:抓取失败(空图/编码失败/抛错)时 dirty 标记未清除,`finally` 每 200ms 重排一次,任务面板打开期间会以 5 次/秒无限抓屏。失败路径现在清除标记,只在有新动作时才重试。
- **下载上限改为流式判定**:此前先 `arrayBuffer()` 读完整包再比 64MiB,超大响应会先撑爆渲染进程,上限形同虚设;现在先看 `content-length`,再边读边累计并在超限时 `cancel()` 流,同时给页内 fetch 加了超时。
- **`browser_upload_file` 加读白名单**:此前只有写有白名单,上传可把任意本地文件交给页面(绕过 DSH 文件策略)。现在 `filePath` 必须存在且落在 `browser-electron.readRoots`(默认同 `writeRoots`)之内,校验在触碰 DOM 之前完成,越界抛 `BROWSER_READ_PATH_DENIED`。
- **任务摘要不再下发缩略图**:`window.__dshTasks` 走页面主世界,此前携带可见任务的 288px JPEG,任意页面可据此读走其他任务的屏幕内容。摘要只保留 `thumbnailVersion`,图片仅经定向的 `task.thumbnail` 补丁下发。写盘拒绝消息也不再回显允许根路径。
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
