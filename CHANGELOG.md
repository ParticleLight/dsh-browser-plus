# Changelog

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
