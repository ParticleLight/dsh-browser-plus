# Changelog

## v0.4.3 (2026-09-30)

- **新增深色空状态页,并修复空白视图上所有操作超时**:新建的 `WebContentsView` 在首次导航前**没有提交任何文档** —— 既按默认白底渲染(和整套深色 UI 格格不入),又让 CDP **没有 frame 可 evaluate**,于是 `browser_execute`/`browser_snapshot`/`browser_content` 全部 30s 超时、`browser_screenshot` 直接报错。现在视图创建时立即加载一个惰性(无可交互元素)的深色空状态页,窗口也设了深色 `backgroundColor`。**两个症状是同一个根因**。
- **修复写盘白名单默认值从未生效**:`entry.ts` 的 `writeRoots`/`readRoots` 声明为 `z.array(z.string())` 而没有默认值,而 schemastery 会把**缺省键物化成 `[]`**;`[]` 不是 nullish,于是 provider 的 `config.writeRoots ?? defaultWriteRoots()` **永远走不到默认分支** —— 结果是文档承诺的「默认 = 工作目录 + 系统临时目录」从来不成立,`browser_screenshot(savePath)` / `browser_download` / `browser_upload_file` 一律以「none configured」被拒。现在默认值在 **schema 层**物化,既让缺省等于文档默认值,又保住「显式 `[]` = 全禁」这个真实语义。
- **可选:把注入 chrome 移进隔离世界**(`browser-electron.chromeWorld: isolated`,**默认仍是 main**)。开启后 chrome 经 `Page.createIsolatedWorld` 注入自己的 JS 世界,`Runtime.addBinding` 也用 `executionContextName` 限定在其中——被访问页面**读不到** `window.__dshTasks` / `window.__dshTrail` / `window.__dshBrowserTaskAction`,连「提前 hook JSON.stringify 偷 binding token」这条残留路径也一并消失。四条注入路径(挂载、bootstrap、patch、active 标记)统一走 `runChromeScript`,导航时丢弃旧 world 以便为新文档重建。**默认未切换**:该改动重写工具栏注入路径,必须在真实窗口按 `docs/SOAK-CHECKLIST.md` 第 8 节逐项验证后再考虑改默认值。
- **下载改由子进程直接落盘**:此前子进程把整包 base64 塞进一行 JSON 回传,父进程再解码写盘——64MiB 的下载在 host→parent→disk 路径上要复制约 8 份(含 RPC 行缓冲)。现在子进程自己写文件、只回 `{ bytes }`,下载体**完全不再经过 RPC socket**,峰值内存与 `MAX_RPC_BUFFER_BYTES` 的压力同时消失。
- **测试 seam 移出声明的 API 面**:`tsconfig` 打开 `stripInternal`,`internals` 与 `DeferredRemoteView` 不再出现在 `lib/*.d.ts` 里(运行时导出保留,定点测试照常可用)。
- **chrome 重装改由宿主执行**:provider 在导航后注入的是**无 token** 的 `PAGE_CHROME_SCRIPT`,而只有宿主持有每视图 token——一旦宿主自身的注入失败,退化的那份会让工具栏按钮静默失效。新增可选的 `reinstallChrome()` seam:自托管宿主经 RPC 重装 token 版,不提供该能力的宿主(桌面外壳)仍走原回退。
- **每次调用的 `timeoutMs` 被夹在工具预算之下**:`browser_wait_for`/`browser_content` 此前把调用方给的值原样下传,所以 `timeoutMs: 90000` 实际会在 60s 被运行时掐断,模型只会收到一条笼统的 tool timeout。现在夹到「预算 − 5s」,并在参数描述里写明上限,让 provider 先给出干净的 `BROWSER_OPERATION_TIMEOUT`。
- **历史记录不再全量深拷贝**:`browser_history` 此前对每条 entry 做 `JSON.parse(JSON.stringify(params))`,把完整脚本与输入文本逐条复制一遍;现在只做浅拷贝并对超长字符串截断(附剩余字数),同时保持 lossless JSON。
- **单条历史有存储上限**:`execute` 的脚本与 `type` 的文本超过 32KiB 时会被截断并打标;`browser_replay` 遇到被截断的条目会明确拒绝(`BROWSER_HISTORY_TRUNCATED`),而不是重放一个被悄悄剪短的脚本。
- **补上两处零覆盖**:① `entry.ts` 的组合入口(外部 viewHost 优先 / 缺省自托管 / 销毁时只 dispose 自托管 host / 配置透传)此前没有任何测试;② 页面 chrome 的 patch 握手(epoch 与 revision 连续性判定)此前只有「标识符还在」的源码断言——现在把它抽成纯函数 `decideChromeMessage` 并真跑:丢包、乱序、重放、跨文档都要 resync 而不是部分应用。
- **自愈不再在空白页上重放输入**:主机崩溃后重建的视图是 `about:blank`,而 `Input.*` 在空白文档上会「什么都不做但正常 resolve」,于是 `browser_click`/`browser_type` 会在页面上什么都没发生的情况下报成功。现在这类命令不再自动重放,而是抛 `BROWSER_HOST_RESTARTED` 并提示重开页面(读类命令仍照常自愈)。
- **快照 `truncated` 语义修正**:此前用 `out.length >= cap` 判断,页面恰好有 cap 个可见候选时会误报截断;现在只有真的因达到上限而提前跳出才算截断。
- **`browser_scroll` 描述与实现对齐**:实际是「约一屏(视口高度的 80%,最少 480px)」,描述原写「one viewport」。
- **新增 CI**:`.github/workflows/ci.yml` 在 push/PR 上跑 `npm ci --omit=optional` + `npm test`,并额外用 `git diff --exit-code -- lib` 校验**已提交的 `lib/`** 与 `src/` 一致——这正是 `pretest` 会掩盖的那类漂移(改了 src、本地重建了 lib,却没提交重建结果)。
- **新增 ESLint 最小集**:只启用类型感知的 `no-floating-promises` / `no-misused-promises` 与两条一致性规则,不引入格式化以免搅动现有风格。首次运行即发现一处真实缺陷:`setWindowOpenHandler` 里的 `loadURL()` 未被 await 也未挂 rejection handler,失败时会产生未处理拒绝。
- **`CHANGELOG.md` 现在会进 npm tarball**(此前 `files` 未列)。
- **缩略图捕获加超时**:`capturePage()` 在合成器卡住时可能永不 settle,而 `finally` 不会执行 → 单飞标志永远为 true,此后缩略图静默停更。现在 5s 超时按失败处理。
- **减少跨进程 IPC**:`syncVisibleTaskVisibility` 此前对**每个** view(含其它任务的隐藏页与后台标签)各发一次 `executeJavaScript`;现在只对 active 状态真正变化的 view 发送。
- **`installPageChrome` 的 active 判定改用 viewId**:此前只比 taskKey,导致可见任务的**后台标签页**导航时被当成「正在显示」,会启动其页面定时器并顶掉真正可见视图的 chrome epoch。
- **`restoreAuth` 逐条隔离**:此前任一条 cookie 非法即整批 reject、已写入不可回滚、调用方也拿不到计数;现在逐条 try/catch 并回报 `{restored, failed}`。
- **会话丢失会自动重开**:工具层按任务缓存 session id;若 provider 被重载(实例换了、不再认识旧 id),此前该任务之后**每次**调用都报 `BROWSER_SESSION_UNKNOWN`,只能靠人想到调 `browser_reset_session`。现在检测到该错误会丢弃缓存并重开一次(仅此一种错误会重试)。
- **`browser_close_tab` 如实返回**:此前无条件 `{closed:true}`,render 里「Tab not found.」是死代码;未知 tabId 与成功无法区分。现在 provider 返回布尔值,工具层如实回填。
- **`browser_handoff` 纳入白名单**:它不是只读工具(会改任务控制状态),此前不受 `browser_restrict` 约束。
- **`browser_screenshot` 仅在写盘时受白名单约束**:不带 `savePath` 的截图仍是只读,保持「只读工具永不拦截」的承诺;带 `savePath` 时按写盘工具守卫。
- **`browser_reset_session` 纳入每任务 FIFO**:此前直接 close,可能把并发排队操作正在使用的会话/视图拆掉。
- **`browser_restrict` 校验名字是否存在**:此前只校验 `browser_` 前缀,拼错(如 `browser_snapsho`)会被接受并静默拒绝该任务所有受守卫动作。
- **输入派发补上超时兜底**:`click`/`clickRef`/`doubleClick`/`hover`/`type`/`pressKey` 的 8 处 `Input.*` 派发此前是裸 `await`,页面主线程被同步 JS 阻塞时会一直挂到工具预算耗尽;现在与其它 CDP 调用一样有 15s 上限并响应调用方 signal。
- **超时错误带稳定 code**:`withTimeout` 现在抛 `BROWSER_OPERATION_TIMEOUT`(保留 `TimeoutError` 名称),此前只有 `execute`/`waitForElement` 两处归一化,其余超时是裸 Error,无法按 code 分支。
- **快照重试有总预算且尊重取消**:空清单重试此前最多 5 次、每次可等满求值超时(理论上约 182s,远超 60s 工具预算),且 `.catch(() => undefined)` 会吞掉 abort 继续重试。现在整段重试有 3s 预算,abort 会立即中止并上抛。
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
