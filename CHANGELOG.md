# Changelog

## v0.6.0 (开发中)
- **`browser_wait_for` 能等文字、也能等东西消失** —— 新增 `text`（有选择器就在元素里找 ✓、没有就查整篇文档 ✓）与 `state`（`visible` 默认 ✓、`attached` 只要存在 ✓、`hidden` / `detached` 等它消失 ✓）；`visible: false` 仍映射到 `attached` ✓。
- **两种等法直接拒绝，不空等到超时** —— 既没选择器也没文字 ✓、`hidden`/`detached` 却没给选择器（不知道等谁消失 ✓）→ `BROWSER_WAIT_INVALID` ✓。

## v0.5.0 (2026-10-03)
**新增四个工具（37 → 41）**
- **`browser_dialog`** —— 查看/引导 `alert`/`confirm`/`prompt`。
- **`browser_console` / `browser_network`** —— 读控制台报错、未捕获异常与网络请求（每个视图各 200 条环形缓冲）。
- **`browser_emulate`** —— 视口（可带移动端行为与 DPR）、自定义 UA、`prefers-color-scheme`；
**改进**
- **`browser_execute` 现在也收语句体**（自动判别：先试表达式，再试脚本体，语句体用 `return` 返回值）。
- **`browser_snapshot` 新增 `query` 与 `limit`** —— 按 kind+label 过滤，且**过滤发生在计上限之前**（否则默认上限 60 之外的元素永远搜不到）。
- **坐标点击落在视口外时明确报错**，并报出那个点上实际是什么元素（坐标点击**不会自动滚动**，以前是静默丢弃）。
**修复**
- **页面缩放 ≠ 100% 时，二级菜单弹层不贴按钮** —— 实测 160% 下偏 330px（`left` 311 → 502）。
- **`browser_dialog` 的 `inspect` 看不到刚触发的对话框** —— 它没有自己排空宿主里的对话框。
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。

## v0.4.3 (2026-09-30)
- **取消抽屉设计 + 页面不再被顶栏遮挡**（用户要求「取消抽屉的设计，同时为了不遮挡，像谷歌浏览器那样处理」）。
- **标签栏显示 favicon**（Chrome 的标签几乎由 favicon 主导，这是「像不像」最显眼的一块）。
- 🔴 **修复：窗口从最小化恢复后，视图不会被重新布局（一直是 0×0）**。
- 🔴 **修复 `showView` 与 `createView` 的竞态 —— 新标签的视图永远不会被显示**。
- **chrome 改成 Chrome 那样的「窗框」，而不是浮动小部件**。
- **注入式 chrome 新增 Chrome 风格标签栏**（渲染层已完成并真机验证）。
- **注入式 chrome 改成 Chrome 式常驻顶栏**。
- **用 DSH 自己的校验器验证全部 37 个工具的 schema**。
- **补上 JS 侧指纹的断言(冒烟共 33 项),并确认现有指纹是自洽的**。
- 🔴 **修复:浏览器直接导出的 cookie 文件会被整份拒绝**。
- **交互效果断言补全到 10 项(冒烟共 31 项)**:新增 **`click_ref`**(文档里的主要交互方式,此前只验证过「调用返回了」,从未验证过「页面收到了」)、双击、滚动、`fill` 选 select 四条**效果断言*…
- **键盘输入此前也在空转(由第 9 轮的修复一并治好,本轮补上断言)**:实测运行中的旧代码,`browser_press_key` 派发后页面收到的 `keydown` 列表**为空** ✗ —— Enter/Tab/Escape/方…
- **新增 `browser_drag`(工具数 36 → 37)**:`from` 按下 → 中间移动 → `to` 释放。
- 🔴 **修复:点击在真实网站上完全不生效**。
- **指针工具支持右键与修饰键**:`browser_click`/`browser_double_click` 新增 `button`(left/right/middle)与 `modifiers`(alt/ctrl/meta/shif…
- **集成冒烟扩到 21 项,覆盖工具层与并行**:新增 ① **真实工具层跑在真实 provider 上**(`browser_open`/`browser_content`/`browser_click`/`browser_snaps…
- **修 `text` 寻址在「逐字符 span」页面上匹配失败(真实集成测试抓到的真 bug)**:文字匹配此前枚举候选标签(`a, button, input, span, div, li, td…`),**漏了 `p` 等大量承载正…
- **新增真实集成冒烟 `npm run smoke:browser-tools`**:用**真实 Electron 宿主 + 真实 Chromium** 驱动**真实 provider**,覆盖 12 项(含 click 三种寻址、sc…
- **`DSH_BROWSER_PLUS_USER_DATA` 可覆盖宿主 profile**:Chromium 对 profile 加单例锁,此前无法并存两个宿主(验证脚本会与运行中的 DSH 冲突)。
- **指针工具支持选择器/文字寻址**:`browser_click`/`browser_double_click`/`browser_hover` 此前**只能给坐标**,想点一个按钮必须先 `browser_snapshot` 拿 `…
- **`browser_scrape` 支持并发**:新增 `concurrency`(默认 1,上限 8),每个 worker 占一个自己的标签页,从共享队列取 URL。
- **`browser_scrape` 改用独立标签页**:此前批次调用的是作用于「会话当前激活标签页」的 `navigate`/`execute`,于是 ① 批次运行期间任何工具调用都会和它**抢同一个标签页**,抽取可能拿到错误的页面…
- **后台批次跳过 250ms 绘制等待**:`waitForDocumentReady` 在 `document.readyState === complete` 后会**固定再等 250ms**,目的是让截图/快照不抓到空白渲染——但…
- **新增 `browser_scrape`:批量抓取,结果直接落盘**:后台批量访问 URL,每页把一行 JSON 追加到文件,**结果完全不经过模型**——一千条与一条的 token 成本相同。
- **`browser_auth` 支持从文件导入登录状态**:新增 `file` 参数(`action=restore`),从 JSON 文件读取 cookie 列表 —— 真实导出动辄几百条,内联经模型传递不现实。
- **对齐请求指纹,减少被判定为机器人**:实测服务端收到的请求里有三处明显破绽 —— ① `User-Agent` 里带着 `Electron/42.9.3`;
- **新增深色空状态页,并修复空白视图上所有操作超时**:新建的 `WebContentsView` 在首次导航前**没有提交任何文档** —— 既按默认白底渲染(和整套深色 UI 格格不入),又让 CDP **没有 frame 可 ev…
- **修复写盘白名单默认值从未生效**:`entry.ts` 的 `writeRoots`/`readRoots` 声明为 `z.array(z.string())` 而没有默认值,而 schemastery 会把**缺省键物化成 `[]…
- **可选:把注入 chrome 移进隔离世界**(`browser-electron.chromeWorld: isolated`,**默认仍是 main**)。
- **下载改由子进程直接落盘**:此前子进程把整包 base64 塞进一行 JSON 回传,父进程再解码写盘——64MiB 的下载在 host→parent→disk 路径上要复制约 8 份(含 RPC 行缓冲)。
- **测试 seam 移出声明的 API 面**:`tsconfig` 打开 `stripInternal`,`internals` 与 `DeferredRemoteView` 不再出现在 `lib/*.d.ts` 里(运行时导出保留,…
- **chrome 重装改由宿主执行**:provider 在导航后注入的是**无 token** 的 `PAGE_CHROME_SCRIPT`,而只有宿主持有每视图 token——一旦宿主自身的注入失败,退化的那份会让工具栏按钮静默失效…
- **每次调用的 `timeoutMs` 被夹在工具预算之下**:`browser_wait_for`/`browser_content` 此前把调用方给的值原样下传,所以 `timeoutMs: 90000` 实际会在 60s 被运行时…
- **历史记录不再全量深拷贝**:`browser_history` 此前对每条 entry 做 `JSON.parse(JSON.stringify(params))`,把完整脚本与输入文本逐条复制一遍;
- **单条历史有存储上限**:`execute` 的脚本与 `type` 的文本超过 32KiB 时会被截断并打标;
- **补上两处零覆盖**:① `entry.ts` 的组合入口(外部 viewHost 优先 / 缺省自托管 / 销毁时只 dispose 自托管 host / 配置透传)此前没有任何测试;
- **自愈不再在空白页上重放输入**:主机崩溃后重建的视图是 `about:blank`,而 `Input.*` 在空白文档上会「什么都不做但正常 resolve」,于是 `browser_click`/`browser_type` 会在…
- **快照 `truncated` 语义修正**:此前用 `out.length >= cap` 判断,页面恰好有 cap 个可见候选时会误报截断;
- **`browser_scroll` 描述与实现对齐**:实际是「约一屏(视口高度的 80%,最少 480px)」,描述原写「one viewport」。
- **新增 CI**:`.github/workflows/ci.yml` 在 push/PR 上跑 `npm ci --omit=optional` + `npm test`,并额外用 `git diff --exit-code -- …
- **新增 ESLint 最小集**:只启用类型感知的 `no-floating-promises` / `no-misused-promises` 与两条一致性规则,不引入格式化以免搅动现有风格。
- **`CHANGELOG.md` 现在会进 npm tarball**(此前 `files` 未列)。
- **缩略图捕获加超时**:`capturePage()` 在合成器卡住时可能永不 settle,而 `finally` 不会执行 → 单飞标志永远为 true,此后缩略图静默停更。
- **减少跨进程 IPC**:`syncVisibleTaskVisibility` 此前对**每个** view(含其它任务的隐藏页与后台标签)各发一次 `executeJavaScript`;
- **`installPageChrome` 的 active 判定改用 viewId**:此前只比 taskKey,导致可见任务的**后台标签页**导航时被当成「正在显示」,会启动其页面定时器并顶掉真正可见视图的 chrome epoc…
- **`restoreAuth` 逐条隔离**:此前任一条 cookie 非法即整批 reject、已写入不可回滚、调用方也拿不到计数;
- **会话丢失会自动重开**:工具层按任务缓存 session id;
- **`browser_close_tab` 如实返回**:此前无条件 `{closed:true}`,render 里「Tab not found.」是死代码;
- **`browser_handoff` 纳入白名单**:它不是只读工具(会改任务控制状态),此前不受 `browser_restrict` 约束。
- **`browser_screenshot` 仅在写盘时受白名单约束**:不带 `savePath` 的截图仍是只读,保持「只读工具永不拦截」的承诺;
- **`browser_reset_session` 纳入每任务 FIFO**:此前直接 close,可能把并发排队操作正在使用的会话/视图拆掉。
- **`browser_restrict` 校验名字是否存在**:此前只校验 `browser_` 前缀,拼错(如 `browser_snapsho`)会被接受并静默拒绝该任务所有受守卫动作。
- **输入派发补上超时兜底**:`click`/`clickRef`/`doubleClick`/`hover`/`type`/`pressKey` 的 8 处 `Input.*` 派发此前是裸 `await`,页面主线程被同步 JS 阻…
- **超时错误带稳定 code**:`withTimeout` 现在抛 `BROWSER_OPERATION_TIMEOUT`(保留 `TimeoutError` 名称),此前只有 `execute`/`waitForElement` 两…
- **快照重试有总预算且尊重取消**:空清单重试此前最多 5 次、每次可等满求值超时(理论上约 182s,远超 60s 工具预算),且 `.catch(() => undefined)` 会吞掉 abort 继续重试。
- **`browser_fill` 不再静默假成功**:checkbox/radio 点击后回读 `checked`,未变更(disabled 或被处理器取消)报 `ok:false`;
- **`browser_content format=json` 不再恒返回 `{}`**:DOM 元素没有自有可枚举属性,`JSON.stringify(document.body)` 永远是 `{}`。
- **`browser_press_key` 支持标点**:此前只认字母数字与功能键,`Ctrl+-`、`Ctrl+/`、`,`、`.`、`[`、`]` 等一律抛 `BROWSER_KEY_UNKNOWN`,而工具描述却写「single …
- **`browser_wait_for` 非法选择器快速失败**:此前会每 250ms 重试直到超时(默认 15s)再报一个误导性的 `BROWSER_WAIT_TIMEOUT`,现在立即抛 `BROWSER_SELECTOR_INVA…
- **工具栏不再吞掉代理点击**:注入 chrome 的顶部中央 280×56 感应区在捕获阶段 `preventDefault` + `stopImmediatePropagation`,且从不检查 Agent 输入抑制窗口,导致落在该…
- **缩略图失败不再 5Hz 重试**:抓取失败(空图/编码失败/抛错)时 dirty 标记未清除,`finally` 每 200ms 重排一次,任务面板打开期间会以 5 次/秒无限抓屏。
- **下载上限改为流式判定**:此前先 `arrayBuffer()` 读完整包再比 64MiB,超大响应会先撑爆渲染进程,上限形同虚设;
- **`browser_upload_file` 加读白名单**:此前只有写有白名单,上传可把任意本地文件交给页面(绕过 DSH 文件策略)。
- **任务摘要不再下发缩略图**:`window.__dshTasks` 走页面主世界,此前携带可见任务的 288px JPEG,任意页面可据此读走其他任务的屏幕内容。
- **`browser_restrict` 改为按任务隔离**:此前白名单是模块级全局状态,一个任务设置后会把**所有**并行任务的浏览器工具一起限制。
- **页面可见轨迹脱敏**:注入页面的 `window.__dshChromeBootstrap.trail` 只保留展示所需字段——`type` 折叠为字符数、`execute` 丢弃脚本、URL 折叠为 origin、路径折叠为 ba…
- **页面→宿主控制通道加每视图 token**:`__dshBrowserTaskAction` 的 payload 必须携带 `createView` 生成的随机 token。
- **读操作纳入每任务 FIFO**:`snapshot`/`content`/`screenshot`/`list_tabs`/`history`/`session`/`space(list)` 现在会等待在飞写操作,修复并发 `bro…
- **主机自愈改用稳定错误码**:新增 `BROWSER_HOST_DEAD` 与 `isBrowserHostDead()`;
- **`available()` 实检**:`ElectronBrowserViewHost` 新增可选 `isAvailable?()`;
- **markdown 抓取修复**:`browser_content format=markdown` 的 walker 现在递归块级容器,标题/链接/列表在常见 `div` 嵌套下不再退化成纯文本。
- **下载内存**:子进程下载上限 256MiB → 64MiB,父进程 RPC 缓冲 512MiB → 128MiB(按 base64 推导保留 1.5× 余量)。
- **`browser_upload_file`**:补 30s 超时与 Agent 输入抑制标记,与其它输入工具一致。
- **`internals`**:标注 `@internal`;
- **写入路径白名单**:`browser_screenshot` 与 `browser_download` 只能写入 `browser-electron.writeRoots`(默认工作目录 + 系统临时目录)之内的路径;
- **下载共用导航准入**:`browser_download` 与 `browser_navigate` 走同一套 URL 准入(仅 HTTP(S),拒绝 URL 内嵌凭据),不再绕过 `httpOnly`。
- **测试可信度**:`npm test` 现在先执行 `tsc`(`pretest`),不再对可能过期的构建产物 `lib/` 做假绿测试;

## v0.4.2 (2026-09-17)
- **按站点清理 Cookie**: `browser_auth action="clear"` 支持按 `domain`(含子域)与/或 `name` 精确删除 Cookie;

## v0.4.1 (2026-08-26)
- **多标签会话恢复**: keyed browser sessions are recovered when the tool-layer session cache is lost, so the first direct switc…

## v0.4.0 (2026-08-26)
- **显式人机交接**: 任务卡显示运行、等待用户、用户接管、失败和空闲状态；
- **语义浏览控制**: 新增后退、前进、刷新、停止、滚动，以及由 `snapshotId` 和元素 ref 驱动的精确点击/滚动到元素工具。
- **轻量工作区同步**: Host 改为 bootstrap + versioned patch；
- **资源预算**: 任务缩略图仅在任务面板打开时按需单飞捕获，带 2 秒节流和 32 项缓存；
- **低干扰工具栏**: 工具栏默认隐入页面上方，顶部中间悬停出现圆形下箭头；

## v0.3.1 (2026-08-23)
- **单窗口任务管理器**: 所有 DSH 任务共享一个可见浏览器窗口，同时保留隔离的任务视图、标签和历史；
- **任务标签**: `browser_space` 命名或列出浏览器任务，不再表示原生窗口；
- **可视工作区**: 任务与操作轨迹可同时打开，切换任务同步轨迹，并显示可见页面的实时缩略图。
- **Browser Flow 图标**: 新增 SVG 主源、PNG/ICO 衍生资源及 Electron 窗口图标接入。

## v0.3.0 (2026-08-21)
Ego 级功能集:
- **JS 对话框**:宿主自动 accept(页面永不卡死),草案以 `drainDialog` 读回并写入 `browser_history`(`dialog` 记录)。
- **输入工具**:`browser_press_key`(CDP keyDown/keyUp,修饰键位掩码)、`browser_double_click`(clickCount 2)、`browser_hover`(mouseMoved…
- **等待与定位**:`browser_wait_for`(250ms 有界轮询,`BROWSER_WAIT_TIMEOUT`);
- **每任务窗口**:每个 DSH 任务一个独立 `BrowserWindow`(createView key);
- **稳定性**:Electron 锁定 42.9.3(43.4.1 组合器故障);
- **质量**:32/32 测试(FakeHost 行为测试 12 条 + 源码断言/页面 chrome 断言);

## v0.2.0 (2026-08-21)
首版 `dsh-browser-plus`:共享可见浏览器、ego 风格页面内工具栏、操作轨迹(trail)面板、用户控制检测、稳定单视图合成。
