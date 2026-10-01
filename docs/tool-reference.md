# 工具参考

全部 36 个 `browser_*` 工具。守卫列:✅ 表示该动作受 `browser_restrict` 白名单约束(白名单**按调用任务隔离**,一个任务的规则不影响其它任务);只读工具永不拦截。

## 页面与导航

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_open` | `url`(必填), `newTab?` | 快照(snapshotId/url/title/elements/truncated/challenge) | ✅ | 打开 URL,返回带编号元素和短生命周期 `snapshotId`;`newTab: true` 在新标签打开 |
| `browser_snapshot` | – | 快照 | – | 交互元素(输入框/按钮/链接)编号清单和 `snapshotId`,供精确定位 |
| `browser_back` | – | `{ navigated }` | ✅ | 返回上一条历史;没有上一页时返回 `false` |
| `browser_forward` | – | `{ navigated }` | ✅ | 前进到下一条历史;没有下一页时返回 `false` |
| `browser_reload` | – | `{ reloaded }` | ✅ | 刷新当前页 |
| `browser_stop` | – | `{ stopped }` | ✅ | 停止当前页加载 |
| `browser_scroll` | `deltaX?`, `deltaY?` | `{ x,y,maxX,maxY }` | ✅ | 按 CSS 像素滚动;无参数时向下一个视口 |
| `browser_wait_for` | `selector`(必填), `timeoutMs?`, `visible?` | `{ found, selector, tag, text? }` | ✅ | 等待 CSS 选择器匹配的元素出现且可见(250ms 轮询,默认 15s 超时);SPA 动态内容交互前使用 |
| `browser_content` | `format`(html/markdown/txt/json,必填), `selector?`, `maxChars?`, `timeoutMs?` | `{ content, truncated }` | – | 抓取页面内容;`selector` 限定区域 |
| `browser_challenge` | – | `{ blocked, kind?, reason?, hint? }` | – | 检测人机验证(CAPTCHA/Cloudflare/reCAPTCHA/hCaptcha/Turnstile);阻塞时请用户处理 |

## 页面操作

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_click_ref` | `snapshotId`, `ref`(必填) | `{ clicked }` | ✅ | 以快照引用进行真实 CDP 点击;页面变化后返回过期引用错误并要求重新快照 |
| `browser_scroll_into_view` | `snapshotId`, `ref`, `block?` | `{ scrolled,x,y,maxX,maxY }` | ✅ | 将快照引用元素滚入可见区域 |
| `browser_execute` | `script`(必填), `args?` | `{ ok, value? / exception? }` | ✅ | 仅在引用、表单和原生浏览工具无法表达时执行页面 JS |
| `browser_click` | `x?`, `y?`, `selector?`, `text?` | `{ clicked, x?, y?, target? }` | ✅ | 点击元素,**三种寻址任选其一**:① `x`+`y` 视口坐标(配合截图做视觉定位,覆盖图标/图片按钮/canvas);② `selector` CSS 选择器;③ `text` 可见文字(或 aria-label/value,不区分大小写)。后两者在**页内解析**并把元素滚入视野,所以「点登录按钮」**不必先 snapshot 拿 ref**(省一轮);返回 `target` 告诉你实际点到了什么。多个匹配时**最内层的可见元素胜出**(文字最短者优先,同长取更深者) |
| `browser_double_click` | `x?`, `y?`, `selector?`, `text?` | `{ clicked, x?, y?, target? }` | ✅ | 同上寻址方式;用于选中文本、展开忽略单击的 UI |
| `browser_hover` | `x?`, `y?`, `selector?`, `text?` | `{ hovered, x?, y?, target? }` | ✅ | 同上寻址方式;悬停不点击(触发 hover 态、tooltip、下拉菜单) |
| `browser_type` | `text`(必填) | `{ typed }` | ✅ | 向聚焦元素输入文本(CDP `Input.insertText`) |
| `browser_press_key` | `key`(必填), `modifiers?` | `{ pressed }` | ✅ | 向聚焦元素物理按键(keyDown+keyUp;Enter/Tab/F1-F12/方向键及 Ctrl+A 等修饰组合) |
| `browser_fill` | `fields`(必填,数组), `submit?` | `{ fields[], submitted }` | ✅ | 批量填表;字段按 `selector`/`name`/`label`/`placeholder` 匹配,值支持字符串/数字/布尔;单个字段失败不影响其余;`submit: true` 提交表单 |
| `browser_upload_file` | `filePath`(必填), `selector?` | `{ path }` | ✅ | 给文件输入附加本地文件(CDP `DOM.setFileInputFiles`,页面视为真实选择);缺省页面第一个 `input[type="file"]`;`filePath` 必须存在且落在 `browser-electron.readRoots` 之内,越界抛 `BROWSER_READ_PATH_DENIED` |

## 标签与会话

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_list_tabs` | – | `{ session, tabs[] }` | – | 当前会话的标签列表 |
| `browser_switch_tab` | `tabId`(必填) | `{ switched }` | ✅ | 按 id 切换标签;自托管下同步切换可见视图 |
| `browser_close_tab` | `tabId`(必填) | `{ closed }` | – | 关闭标签;关闭活动标签后激活下一个 |
| `browser_reset` | – | `{ reset }` | ✅ | 关闭本任务所有标签,回到一个空白标签 |
| `browser_session` | – | `{ session, tabs[] }` | – | 查看本任务的浏览器会话与标签 |
| `browser_space` | `label?` | `{ label? / spaces[] }` | – | 命名本浏览器任务或列出浏览器任务；页面任务管理器控制哪个隔离任务视图显示在共享窗口中 |
| `browser_tasks` | – | `{ tasks[] }` | – | 查看每个任务的状态、控制方、标签页数、最近动作和错误摘要 |
| `browser_handoff` | `state`(`waiting-user` / `agent`) | 当前任务状态 | – | 让 Agent 等待用户操作，或在用户交还后恢复 Agent 控制 |
| `browser_reset_session` | – | `{ reset }` | ✅ | 关闭并重建本任务的浏览器会话(崩溃/卡死后恢复) |

## 历史与下载

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_history` | – | `{ entries[] }` | – | 操作日志(最新在后),含 seq/action/ok/params/result/error |
| `browser_replay` | `seq`(必填) | `{ replayed }` | ✅ | 按序号回放某一步(navigate/execute/click/type) |
| `browser_download` | `url`(必填), `savePath`(必填) | `{ path }` | ✅ | 带会话 cookie 下载到本地(上限 64MB,受 CORS 约束);`savePath` 受 `writeRoots` 限制,URL 与导航共用 HTTP(S) 准入(拒绝内嵌凭据) |

## 登录态与安全

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_auth` | `action`(flush/restore/clear,必填), `cookies?`, `file?`, `domain?`, `name?`, `all?` | `{ cookies[]? / restored? / failed? / removed? , names[]? }` | ✅ | 导出/恢复/清理 cookie(自托管可用);flush 返回列表,restore 写回,clear 按 domain(含子域)与/或 name 精确删除,未限定范围时必须显式 `all: true` |
| `browser_restrict` | `allowed?` | `{ restrictedTo[] }` | – | 设置**本任务**的动作白名单;空列表解除本任务的限制;未知工具名报错 |

## 批量抓取

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_scrape` | `action?`(start/status/stop/list), `urls?`, `script?`, `outPath?`, `waitFor?`, `timeoutMs?`, `concurrency?`, `id?` | `{ id?, state?, total?, done?, failed?, path?, error?, jobs[]? }` | ✅ | 后台批量访问 URL,把**每页一行 JSON** 追加到文件,结果**不经模型往返**——一千条与一条的 token 成本相同。`action=start` 立即返回,用 `action=status` 轮询。每行是 `{ seq, url, ok, data }` 或 `{ seq, url, ok, error }`(`seq` = 该 URL 在输入里的下标;并发时行按**完成顺序**落盘,按 `seq` 排序即可还原),**产生即落盘**,所以 `stop` 或中断都保留已抓到的行;单页失败不终止整批(计入 `failed`)。`outPath` 受 `writeRoots` 限制并在开始时截断。批次使用**自己的标签页**(不激活,所以不会抢走你正在看的页面,也不与同任务的工具调用争用),结束后销毁。`concurrency` 默认 1、上限 8,每个 worker 占一个标签页;后台批次**跳过 250ms 的绘制等待**(它只读 DOM 不读像素),实测单页开销约 6ms。

## 截图

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_screenshot` | `fullPage?`, `savePath?` | `{ dataUrl, path? }` | – | PNG 截图;`savePath` 落盘供视觉模型读取,且必须落在 `browser-electron.writeRoots` 之内 |

## 常用组合

**调研一个网站**
```
browser_open https://site → browser_content format=markdown → browser_snapshot → browser_click_ref(snapshotId, ref) → 逐页浏览
```

**登录并下载文件**
```
browser_open https://site/login → browser_fill(用户名/密码) submit=true →
等待跳转 → browser_download(url, savePath)
```

**表单填写(React/Vue 页面)**
```
browser_snapshot → browser_fill(fields=[{name:'email',value:'a@b.c'},{label:'密码',value:'***'}], submit=true)
```

**误操作恢复**
```
browser_reset_session → browser_open(重新开始)
```

**遇到验证码**
```
browser_challenge → browser_handoff state=waiting-user → 用户在共享窗口完成验证并交还 Agent →
browser_snapshot 复查
```