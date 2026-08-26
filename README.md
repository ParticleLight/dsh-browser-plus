# dsh-browser-plus

专为 DeepSeek Harness（DSH）打造的 EGO 风格可视化 Agent 浏览器。基于 `dsh-browser` 构建，支持人机协同操作：用户可以在真实页面中操作，Agent 也能同步执行、接管和恢复任务。浏览器支持多任务流并行管理与切换，并完整记录 Agent 的操作轨迹；任务流和操作轨迹均配备独立的可视化菜单面板，让任务状态、页面缩略图与操作过程一目了然。

基于 MIT 许可的 `dsh-browser` 代码基础持续开发，并由 ParticleLight 独立维护。

[![GitHub stars](https://img.shields.io/github/stars/ParticleLight/dsh-browser-plus?style=flat&label=stars)](https://github.com/ParticleLight/dsh-browser-plus)

## 为何使用它

浏览器自动化不应躲在用户看不见的进程里。dsh-browser-plus 把浏览器窗口留在用户眼前，同时让 agent 获得可靠的 CDP 操作能力。

- **真实可见**：Electron `WebContentsView`，不是 headless relay。
- **任务隔离**：所有 DSH session 共享一个可见窗口，但各自保留隔离的任务视图、标签与历史；页面任务管理器切换可见视图，`browser_space` 命名浏览器任务。
- **人机协作**：工具栏默认隐入页面上方，顶部中间悬停后可展开；书签、任务工作区与操作轨迹都在真实页面上运行，用户可在工具栏最右侧接管或显式交还给 Agent。
- **玻璃工作区**：任务与操作轨迹是彼此独立的半透明玻璃面板，可同时打开；每项任务显示执行中、等待用户、用户接管、失败或空闲状态。缩略图仅在任务面板打开时为当前可见任务按需刷新，后台任务保留最后图像。

![dsh-browser-plus 任务工作区](assets/readme-glass-workspace.png)

- **真实输入**：键盘、鼠标、hover、双击和文件选择都走 CDP，而不是 `element.click()` 伪事件。
- **恢复能力**：child 回收后会重新物化相同会话的视图；恢复后的首张截图等待 compositor 稳定。
- **稳定基线**：固定 Electron 42.9.3；43.4.1 的 compositor 故障会被 resolver 拒绝。

## 安装

```sh
dsh plugin --profile web add github:ParticleLight/dsh-browser-plus
```

已有浏览器 bundle 时，先阅读[迁移指南](docs/MIGRATION.md)，然后重启 DSH Web。

## 主要能力

| 场景 | 工具 |
| --- | --- |
| 打开与读取 | `browser_open`、`browser_snapshot`、`browser_content`、`browser_screenshot` |
| 语义导航 | `browser_back`、`browser_forward`、`browser_reload`、`browser_stop`、`browser_scroll` |
| 快照引用 | `browser_click_ref`、`browser_scroll_into_view` |
| 页面交互 | `browser_click`、`browser_press_key`、`browser_double_click`、`browser_hover`、`browser_type` |
| 表单与文件 | `browser_fill`、`browser_upload_file`、`browser_wait_for` |
| 任务与交接 | `browser_tasks`、`browser_handoff`、`browser_list_tabs`、`browser_switch_tab`、`browser_close_tab`、`browser_space` |
| 登录与恢复 | `browser_auth`、`browser_reset_session`、`browser_history` |

快照返回短生命周期的 `snapshotId` 与元素引用；优先用 `browser_click_ref` 或 `browser_scroll_into_view` 操作，页面变化后重新快照。页面级脚本会自动过滤浏览器自身 chrome。

## 工作方式

```text
browser_* tools
  -> BrowserRuntime (ctx.browser seam)
  -> ElectronBrowserProvider (CDP)
  -> RemoteElectronViewHost (loopback JSON-RPC)
  -> host-main.js (BrowserWindow + WebContentsView)
```

页面 chrome 和任务管理器通过 closed Shadow DOM 注入，而不是第二个 Electron view；任务状态与轨迹以版本化增量消息同步，后台任务更新自己的隔离视图，不会抢走用户当前可见页面。

`alert`、`confirm`、`prompt` 会自动接受，避免页面卡死；下一次页面操作会把详情记到 `browser_history` 的 `dialog` 条目。

## 可靠性规则

1. 不 reparent 可见 `WebContentsView`。
2. CDP capture 回退只临时处理同一窗口的 sibling，并保证恢复。
3. child 恢复后，native 和 full-page capture 都只等待一次 compositor settle。
4. 对话框、截图、动态等待和 child recovery 均有回归测试与真实 SOAK 覆盖。

完整运行时检查见 [SOAK-CHECKLIST](docs/SOAK-CHECKLIST.md)。

## 开发

```sh
npm install
npm run build
npm test
npm run smoke:electron-host # 需要本地 DSH Web 已启动；验证真实 Electron Host 导航与页面交接
```

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。更完整的使用说明在 [docs](docs/README.md)。

## License

MIT。详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE.md)。
