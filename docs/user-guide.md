# 用户指南

## 环境要求

- DeepSeek Harness(dsh)且安装了 `web` profile
- **Electron 运行时**(可选 package dependency):插件固定 `42.9.3` 并优先使用自身安装的 binary；纯 `dsh web` 下找不到该版本会明确失败，避免 43.x compositor 故障。

## 安装

```sh
# 从 npm 安装(已发布)
dsh plugin --profile web add github:ParticleLight/dsh-browser-plus

# 或从源码目录(独立仓库,一插件一仓库)
dsh plugin --profile web add <本仓库路径>
```

安装会链接插件、把 `dsh-browser-plus` 加入 profile 的 bundle 层,并挂载三行:

| 行 | 子路径 | 角色 |
| --- | --- | --- |
| `browser` | `dsh-browser-plus/browser` | `ctx.browser` 能力 seam(始终挂载) |
| `browser-electron` | `dsh-browser-plus/browser-electron` | Electron CDP provider |
| `tool-browser` | `dsh-browser-plus/tool-browser` | `browser_*` 模型侧工具 |

> 没有桌面外壳时插件**自托管**:自己拉起一个标题为 `dsh-browser-plus` 的 Electron 窗口,`browser_*` 工具照常可用。

## 配置

| 行 | 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `browser-electron` | `viewHost` | 对象 | 必填 | 宿主提供的 `ElectronBrowserViewHost`(通常 `!!js ctx.get('electronViewHost')`) |
| `browser-electron` | `httpOnly` | 布尔 | `true` | 仅允许 HTTP(S) 导航;`file:`/`data:` 等拒绝 |
| `browser-electron` | `snapshotMaxElements` | 数字 | `60` | 快照最多收录的交互元素数 |
| `browser-electron` | `contentMaxChars` | 数字 | `100000` | 内容抓取默认字符上限 |
| `tool-browser` | `timeoutMs` | 数字 | `60000` | 工具协作超时(ms) |
| `tool-browser` | `tabTools` | 布尔 | `true` | 是否注册标签管理工具 |

## 快速上手(给 agent 的提示词示例)

```
1. browser_open 打开 https://example.com
2. browser_snapshot 查看页面有哪些可交互元素、编号和 snapshotId
3. 优先 browser_click_ref(snapshotId, ref) 或 browser_scroll_into_view(snapshotId, ref),页面变化后重新快照
4. 需要填表时用 browser_fill(按 name/label/placeholder 匹配,一次填多个字段)
5. 后退、前进、刷新、停止和滚动使用 browser_back/browser_forward/browser_reload/browser_stop/browser_scroll
6. 遇到验证码(browser_challenge 或快照标注 CHALLENGE)时,调用 browser_handoff state=waiting-user,停下等待用户交还任务
```

## 操作纪律

- **优先用快照引用**:先取得 `snapshotId`,再用 `browser_click_ref` 或 `browser_scroll_into_view`;引用过期时重新快照，而不是猜测同名控件。
- **常用浏览操作不用写脚本**:后退、前进、刷新、停止和滚动优先使用对应 `browser_*` 工具。
- **表单优先批量填写**:React/Vue 页面用 `browser_fill`;坐标点击只保留给 canvas、图标等没有语义节点的控件。
- **browser_execute 是最后手段**:只在新工具无法表达的页面特有操作中使用。
- **DPR 注意**:CDP 输入使用 CSS 像素;高 DPI 屏上若点击落空,用 `elementFromPoint` 校准,不要盲试坐标。

## 多任务并行

每个 DSH 会话(任务)拥有独立的浏览器会话(独立标签页与历史),并发任务互不干扰:

- `browser_session` 查看本任务的会话与标签;
- `browser_reset_session` 关闭并重建本任务的会话(崩溃或卡死后用它恢复)。

当前版本使用**一个共享可见浏览器窗口**，每个任务仍有隔离的任务视图、标签与历史。页面任务管理器切换可见任务；后台任务操作只更新自己的视图，不会抢走当前页面。`browser_space label="..."` 为本浏览器任务命名，`browser_space`(无参)列出全部浏览器任务。

工具栏默认收在页面上方。鼠标移到页面顶部中间时会出现小圆形下箭头，点击后工具栏从上方滑出；工具栏最右侧的上箭头会收回工具栏，并同时关闭书签、任务与轨迹浮层。任务按钮打开左侧工作区面板，操作轨迹按钮在桌面端打开右侧工作区面板。顶部工具栏最右侧常驻“接管 / 交还 Agent”控件，不必先打开任务面板；任务卡继续显示执行中、等待用户、用户接管、失败和空闲状态。接管期间新的 Agent 页面操作会停止，快照和内容读取仍可用于确认状态。

用户直接点击页面、编辑表单或使用非滚动键盘操作时，会自动切换为用户控制；滚轮、触摸拖动、滚动条操作，以及页面非编辑区的上下翻页键不会触发接管。Agent 自己的 CDP 鼠标和键盘输入带有短暂抑制标记，不会误交还控制权。

任务与轨迹状态采用版本化增量更新：普通操作只更新受影响的任务卡和一条轨迹。缩略图仅在工作区打开时按需刷新当前可见任务，后台任务保留最后图像。

页面原生 `alert/confirm/prompt` 会被**自动接受**(页面永不卡死),对话框内容记录在 `browser_history`(`dialog` 条目)中。

按键、双击、悬停、文件上传、等待元素、快照引用和原生导航:见 `browser_press_key` / `browser_double_click` / `browser_hover` / `browser_upload_file` / `browser_wait_for` / `browser_click_ref` / `browser_back` 等工具(完整参考见 [工具参考](tool-reference.md))。

登录态(cookie)为所有任务共享;可用 `browser_auth` 导出/恢复,重启后不丢。

## FAQ

**Q:纯 `dsh web` 能用吗?**
能。插件自托管:自己拉起 Electron 窗口,无需桌面外壳。

**Q:找不到 Electron?**
插件只接受 Electron `42.9.3`:优先自身 optional dependency，其次校验 `ELECTRON_PATH`、DSH 锚点与 pnpm store 候选。找不到时重新安装插件依赖，或把 `ELECTRON_PATH` 指向一个经 package metadata 验证为 `42.9.3` 的 binary。

**Q:截图失败或挂起?**
确认运行时是 Electron `42.9.3`，不要用 43.x。自托管截图优先走原生 `capturePage`，共享窗口内存在多个视图且目标未激活时自动兜底到 CDP。

**Q:浏览器窗口不见了?**
窗口标题为 `dsh-browser-plus`(显示当前任务标签时为 `dsh-browser-plus — <名>`)；所有任务共享这一可见窗口，通过页面任务管理器切换各自隔离视图。若子进程崩溃会自动重启;重启后旧会话失效,调用 `browser_reset_session` 重建。

**Q:下载报 CORS 错误?**
`browser_download` 在页面上下文内 `fetch`,受同源/CORS 约束;跨域文件请先在同源页面内操作,或直接请求用户提供。

**Q:如何禁止 agent 乱点?**
`browser_restrict` 设置白名单(如只允许 `browser_snapshot`/`browser_content`);传空列表解除。

## 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `BROWSER_SESSION_UNKNOWN` | 子进程重启后旧会话失效 | `browser_reset_session` |
| 工具超时 | 页面卡死/未渲染完成 | 稍后重试;`browser_reset` 重置标签 |
| 导航被拒 | 非 HTTP(S) 协议 | 检查 URL;`httpOnly` 配置 |
| 快照为空 | 页面尚未加载 | 等待后重试 `browser_snapshot` |