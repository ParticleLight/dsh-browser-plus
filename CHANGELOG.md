# Changelog

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
