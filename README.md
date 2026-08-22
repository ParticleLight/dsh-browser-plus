# dsh-browser-plus

> DeepSeek Harness 的可见浏览器运行时。人和 agent 操作同一个真实页面，不是无头回放，也不是截图代理。

[![GitHub stars](https://img.shields.io/github/stars/ParticleLight/dsh-browser-plus?style=flat&label=stars)](https://github.com/ParticleLight/dsh-browser-plus)

## 为何使用它

浏览器自动化不应躲在用户看不见的进程里。dsh-browser-plus 把浏览器窗口留在用户眼前，同时让 agent 获得可靠的 CDP 操作能力。

- **真实可见**：Electron `WebContentsView`，不是 headless relay。
- **任务隔离**：每个 DSH session 拥有独立窗口、标签与历史；`browser_space` 直接命名窗口标题。
- **人机协作**：页面工具栏、书签、操作轨迹和用户活动检测都在真实页面上运行。
- **真实输入**：键盘、鼠标、hover、双击和文件选择都走 CDP，而不是 `element.click()` 伪事件。
- **恢复能力**：child 回收后会重新物化相同会话的视图；恢复后的首张截图等待 compositor 稳定。
- **稳定基线**：支持 Electron 42.9.3；43.4.1 的 compositor 故障不在支持范围。

## 安装

```sh
dsh plugin --profile web add github:ParticleLight/dsh-browser-plus
```

已有浏览器 bundle 时，先阅读[迁移指南](docs/MIGRATION.md)，然后重启 DSH Web。

## 主要能力

| 场景 | 工具 |
| --- | --- |
| 打开与读取 | `browser_open`、`browser_snapshot`、`browser_content`、`browser_screenshot` |
| 页面交互 | `browser_click`、`browser_press_key`、`browser_double_click`、`browser_hover`、`browser_type` |
| 表单与文件 | `browser_fill`、`browser_upload_file`、`browser_wait_for` |
| 窗口与标签 | `browser_list_tabs`、`browser_switch_tab`、`browser_close_tab`、`browser_space` |
| 登录与恢复 | `browser_auth`、`browser_reset_session`、`browser_history` |

快照元素带有 `loc=`，能可靠回到同一个控件；页面级脚本会自动过滤浏览器自身 chrome。

## 工作方式

```text
browser_* tools
  -> BrowserRuntime (ctx.browser seam)
  -> ElectronBrowserProvider (CDP)
  -> RemoteElectronViewHost (loopback JSON-RPC)
  -> host-main.js (BrowserWindow + WebContentsView)
```

页面 chrome 通过 closed Shadow DOM 注入，而不是第二个 Electron view，因此不会破坏 capture 或多窗口合成。

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
node --test test/host-composition.test.mjs test/page-chrome.test.mjs test/provider-actions.test.mjs
```

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。更完整的使用说明在 [docs](docs/README.md)。

## License

MIT。详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE.md)。
