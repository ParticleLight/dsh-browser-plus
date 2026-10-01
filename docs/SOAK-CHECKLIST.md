# 重启后浸泡验证清单(SOAK-CHECKLIST)

> 前置:重启 DSH Web(使 provider/remote-host/tool-browser 新代码生效),然后在 DSH 会话中依次执行。
> 每个工具调用后记录结果;任何**白屏**立即停止并回滚 host-main.js 至上一提交。

## 0. 不重启也能跑的真实集成冒烟(先跑这个)
```bash
npm run smoke:browser-tools
```
用**真实 Electron 宿主 + 真实 Chromium** 驱动**真实 provider**,覆盖 **31 项**:

- **provider 层(12 项)**:navigate / content / snapshot / screenshot / **click 三种寻址(坐标、选择器、文字)** /
  目标缺失的错误码 / waitForElement / **scrape 并发** / **cookie 导出→文件→清除→导入往返** / listTabs。
- **工具层(6 项)**:真实 `apply(ctx)` 注册的工具跑在真实 provider 上 —— `browser_open` / `browser_content` /
  `browser_click`(文字寻址) / `browser_snapshot` / `browser_scrape`(start+status) / `browser_auth`(file)。
  每次调用还会**逐字段比对声明的输出 schema**——DSH 会在运行时校验输出,而直接调 `execute()` 绕过了它。
- **输入真的到达页面(10 项)**:左键 → 页面应收到 `mousedown,mouseup,click`;右键 → 页面自己的
  `contextmenu` handler 应收到且 `button:2`;修饰键 → `shiftKey` 与 `ctrlKey` 均应为真;
  拖拽 → 手势应跨多次移动、按在源、释放在目标;键盘 → 页面应收到 `keydown`(Enter);
  输入法 → 聚焦的输入框内容应变成所输入文本;**`click_ref`**(文档里的主要交互方式) → 快照取 ref
  再点,页面应收到 `mousedown,click`;双击 → 页面应收到 `dblclick`;滚动 → `scrollY` 应真的变化
  (页面本身不够长时先注入高元素);`fill` 选 select → 其 `value` 应变成所设值。
  **这一组全部断言「页面真的收到了」,而不是「调用返回了」** —— 后者会漏掉整类静默失效。
  **这三项曾长期为假绿**(只验证「目标解析对了」,空串也算通过)。它们现在能通过,靠的是
  `Emulation.setFocusEmulationEnabled` —— **Chromium 会在渲染进程自认未聚焦时丢弃合成的鼠标按压**,
  而移动不受此门控,所以 `hover` 一直正常、掩盖了点击全废。`data:` URL 的渲染器在进程内不做这个门控,
  因此**本地用 `data:` 页面做输入验证会得出错误的「一切正常」** —— 必须打真实站点。
- **并行与规模(3 项)**:双任务(A 跑抓取时 B 的 snapshot 应在毫秒级返回)/ 两个任务各持独立会话 /
  **100 个 URL @ 并发 8**(应为 100 行、100 个不同 `seq`、0 失败,结束后标签页数回到 1)。

- 它自带 profile(`DSH_BROWSER_PLUS_USER_DATA` 指向临时目录),**不与正在运行的 DSH 抢 profile 锁**,所以可以在 DSH 运行时跑;会短暂弹出一个窗口。
- 退出码 0 = 全绿。任何 FAIL 都会打印期望与实际。
- 这是唯一覆盖「provider → RPC → host-main → CDP → Chromium」整条链路的检查:单测用的是假宿主,够不到这一层。
- **历史**:它第一次跑就抓到一个真 bug —— 文字匹配的候选标签表漏了 `p`,导致「正文被拆成逐字符 span」的页面(example.com 现在就是这样)匹配不到容器。

## 1. 对话框自动处理
- [ ] `browser_open https://example.com`(host child 全新启动,无白屏)
- [ ] `browser_execute` 脚本 `setTimeout(() => { window.confirm('soak'); }, 0); 'scheduled'` → 页面不卡
- [ ] 二次 `browser_execute Date.now()` 返回数字(confirm 已自动 accept)
- [ ] `browser_history` 出现 `#n dialog ok {"type":"confirm",...}`

## 2. 输入工具(GUI 受控)
- [ ] `browser_execute` 聚焦输入后 `browser_press_key key="Enter"` → 快照见行为变化;history 有 pressKey
- [ ] `browser_press_key key="a" modifiers=["ctrl"]`(键盘事件低位键 'a')
- [ ] `browser_double_click` 选中文本段;history 有 doubleClick
- [ ] `browser_hover` 导航项 → `browser_screenshot` 目视 hover 态;history 有 hover
- [ ] `browser_execute` 注入 `<input type=file>` → 在工作目录/临时目录建样本文件 → `browser_upload_file filePath=<该文件绝对路径>` → `browser_execute` 读 `input.files[0]?.name` 与文件同名
- [ ] 传根外路径(如 `C:\Windows\win.ini`)调用 `browser_upload_file` → 必须报 `BROWSER_READ_PATH_DENIED`,且页面收不到该文件

## 3. 等待与定位
- [ ] `browser_wait_for selector="a[href]"` 立即命中(iana.org)
- [ ] 动态元素:注入延时节点后 `browser_wait_for selector="#late"` 命中
- [ ] `browser_snapshot` 每行含 `loc=`，结果含 `snapshotId`
- [ ] `browser_click_ref(snapshotId, ref)` 点击快照中的链接或按钮；导航后用旧 snapshotId 再调用应明确提示重新快照
- [ ] `browser_scroll` 无参数向下滚动；`browser_scroll_into_view(snapshotId, ref)` 将目标滚入视口
- [ ] `browser_back` / `browser_forward` / `browser_reload` / `browser_stop` 分别与页面工具栏行为一致

## 4. 共享窗口、任务管理器与 space
- [ ] 本会话 `browser_open https://www.iana.org/` → 一个可见 `dsh-browser-plus` 窗口和对应任务视图
- [ ] **另一个 DSH 会话** `browser_open https://www.w3.org/` → 仍只有**一个共享窗口**，页面任务管理器显示两个隔离任务
- [ ] `browser_space label="奖励任务"` → 当前浏览器任务在任务管理器中显示该标签，活动时标题为 `dsh-browser-plus — 奖励任务`;history 有 setSpace
- [ ] `browser_space`(无参)→ 列出全部浏览器任务(key + label);不产生新窗口
- [ ] 在任务管理器切换两个任务 → 各自 URL/标签正确；隐藏任务的浏览器操作更新自身状态但不抢当前可见页面
- [ ] Agent 执行长等待时任务卡显示“执行中”；调用 `browser_handoff state=waiting-user` 后显示“等待用户”
- [ ] 在当前任务卡点击“接管” → 显示“用户接管”，新的 Agent 页面操作被拒绝；点击“交还 Agent”后恢复操作
- [ ] `browser_tasks` 的状态、控制方、标签页数和最近动作与任务卡一致
- [ ] 关闭共享窗口后再次 `browser_open` → 窗口重建且不残留

## 5. 增量更新与性能
- [ ] 打开任务和轨迹面板后连续执行 100 次轻量页面操作 → 当前任务轨迹持续追加，其他任务卡不闪烁或重建
- [ ] 创建至少 3 个任务、每个 2 个标签 → 后台页面不持续刷新缩略图；打开任务面板并切换当前任务后才刷新当前缩略图
- [ ] 保持任务面板关闭执行操作 → 无可见缩略图捕获；重新打开后当前任务缩略图按需更新

## 6. 稳定性
- [ ] 连续导航 5 站(example.com → bing.com → w3.org → iana.org → example.com)→ 无白屏,每窗口有且仅有一个视图
- [ ] 回收 Electron child(Get-CimInstance ... Stop-Process)→ 下一次工具调用自动重启、无残留窗口
- [ ] `browser_auth action="flush"` → cookies 数量正常(换名安装前迁移用)

## 7. 已知 deferred minors(合并后择机)
见 `.superpowers/sdd/2026-08-21-dsh-browser-plus-ego-features/progress.md` 的 "minor (deferred)" 行(全部为非阻塞风格/文档项)。
## 8. chrome 隔离世界(可选,默认关)

仅在把 `browser-electron.chromeWorld` 设为 `isolated` 后执行。这一步会改变工具栏的注入世界,必须逐项人工确认后才可切换默认值:

**可自动验证的部分**(不需要 DSH 重启,自己起一个隔离 profile 的宿主):
```bash
npm run smoke:chrome-world
```
它做 **A/B 对照**并断言:两种模式下工具栏都挂载 ✓;**默认(main)模式会把 `__dshTasks`/`__dshTrail` 泄露给页面** ✗;`isolated` 模式下两者对页面**均为 `undefined`** ✓ —— 后者正是下面第 4 条的核心断言。
**注意**:脚本**不**断言 `__dshBrowserTaskAction` —— 它是**异步出现**的(2.5s 与 3s 两次测量结果不同),固定等待测不准,故只记录不断言。

- [ ] `browser_open https://example.com` → 工具栏正常显示,顶部中央悬停可展开
- [ ] 点击「接管」→ 状态变为等待用户;点击「交还 Agent」→ 恢复(隔离世界内 binding 仍能触发 set-control-owner)
- [ ] 打开任务面板与轨迹面板 → 任务卡、缩略图、操作轨迹正常渲染与追加
- [ ] 在页面控制台执行 `[typeof window.__dshTasks, typeof window.__dshTrail, typeof window.__dshBrowserTaskAction]` → 三项**全部为 undefined**
- [ ] 切换任务后,旧视图的 chrome 停表(无残留定时器);切回后工具栏与面板状态正确
- [ ] 连续导航 5 站 → 无白屏、工具栏每次都重新出现(每次导航会新建一个隔离世界)
- [ ] 回收 Electron child → 下一次调用自愈后工具栏仍正常
