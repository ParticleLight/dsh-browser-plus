# 重启后浸泡验证清单(SOAK-CHECKLIST)

> 前置:重启 DSH Web(使 provider/remote-host/tool-browser 新代码生效),然后在 DSH 会话中依次执行。
> 每个工具调用后记录结果;任何**白屏**立即停止并回滚 host-main.js 至上一提交。

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
- [ ] `browser_execute` 注入 `<input type=file>` → `browser_upload_file filePath=C:\Windows\win.ini` → `browser_execute` 读 `input.files[0]?.name` = win.ini

## 3. 等待与定位
- [ ] `browser_wait_for selector="a[href]"` 立即命中(iana.org)
- [ ] 动态元素:注入延时节点后 `browser_wait_for selector="#late"` 命中
- [ ] `browser_snapshot` 每行含 `loc=`

## 4. 每任务窗口与 space
- [ ] 本会话 `browser_open https://www.iana.org/` → 窗口标题 `dsh-browser-plus`(默认键)
- [ ] **另一个 DSH 会话** `browser_open` → 出现**第二个独立窗口**,两窗口各自显示且互不遮挡
- [ ] `browser_space label="奖励任务"` → 窗口标题变 `dsh-browser-plus — 奖励任务`;history 有 setSpace
- [ ] `browser_space`(无参)→ 列出所有窗口(key + label);不产生新窗口
- [ ] 关闭任意窗口后再次 `browser_open`(同键)→ 窗口重建不残留

## 5. 稳定性
- [ ] 连续导航 5 站(example.com → bing.com → w3.org → iana.org → example.com)→ 无白屏,每窗口有且仅有一个视图
- [ ] 回收 Electron child(Get-CimInstance ... Stop-Process)→ 下一次工具调用自动重启、无残留窗口
- [ ] `browser_auth action="flush"` → cookies 数量正常(换名安装前迁移用)

## 6. 已知 deferred minors(合并后择机)
见 `.superpowers/sdd/2026-08-21-dsh-browser-plus-ego-features/progress.md` 的 "minor (deferred)" 行(全部为非阻塞风格/文档项)。
