# 工具参考

全部 35 个 `browser_*` 工具。守卫列:✅ 表示该动作受 `browser_restrict` 白名单约束;只读工具永不拦截。

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
| `browser_click` | `x`, `y`(必填) | `{ clicked }` | ✅ | 视口坐标点击(配合截图做视觉定位) |
| `browser_double_click` | `x`, `y`(必填) | `{ clicked }` | ✅ | 视口坐标双击(选中文本、展开忽略单击的 UI) |
| `browser_hover` | `x`, `y`(必填) | `{ hovered }` | ✅ | 视口坐标悬停不点击(触发 hover 态、tooltip、下拉菜单) |
| `browser_type` | `text`(必填) | `{ typed }` | ✅ | 向聚焦元素输入文本(CDP `Input.insertText`) |
| `browser_press_key` | `key`(必填), `modifiers?` | `{ pressed }` | ✅ | 向聚焦元素物理按键(keyDown+keyUp;Enter/Tab/F1-F12/方向键及 Ctrl+A 等修饰组合) |
| `browser_fill` | `fields`(必填,数组), `submit?` | `{ fields[], submitted }` | ✅ | 批量填表;字段按 `selector`/`name`/`label`/`placeholder` 匹配,值支持字符串/数字/布尔;单个字段失败不影响其余;`submit: true` 提交表单 |
| `browser_upload_file` | `filePath`(必填), `selector?` | `{ path }` | ✅ | 给文件输入附加本地文件(CDP `DOM.setFileInputFiles`,页面视为真实选择);缺省页面第一个 `input[type="file"]` |

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
| `browser_download` | `url`(必填), `savePath`(必填) | `{ path }` | ✅ | 带会话 cookie 下载到本地(上限 256MB,受 CORS 约束) |

## 登录态与安全

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_auth` | `action`(flush/restore,必填), `cookies?` | `{ cookies[]? / restored? }` | ✅ | 导出/恢复 cookie(自托管可用);flush 返回 cookie 列表,restore 带列表写回 |
| `browser_restrict` | `allowed?` | `{ restrictedTo[] }` | – | 设置动作白名单;空列表解除;未知工具名报错 |

## 截图

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_screenshot` | `fullPage?`, `savePath?` | `{ dataUrl, path? }` | – | PNG 截图;`savePath` 落盘供视觉模型读取 |

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
