# 从 dsh-builtin-browser 迁移到 dsh-browser-plus v0.3.0

> 本仓库(https://github.com/ParticleLight/dsh-browser-plus)已发布 **v0.3.0**(Release 含 tarball)。
> 若本机曾以旧名 `dsh-builtin-browser` 安装(live 目录: `~/.dsh/profiles/web/node_modules/dsh-builtin-browser/`),按本指南换名安装并迁移登录态。

## 步骤

### 1. 导出旧包登录态(可选但推荐)

在旧包仍生效的 DSH 会话中:

```
browser_auth action="flush"      # 把返回的 cookies JSON 保存到文件
```

### 2. 安装新包(正式名 dsh-browser-plus)

```sh
# 从 GitHub 安装(推荐;或使用 release tarball 或源码目录)
dsh plugin --profile web add github:ParticleLight/dsh-browser-plus
```

### 3. 移除旧包(可选)

```sh
dsh plugin --profile web remove dsh-builtin-browser   # 如实际安装名如此
```

### 4. 恢复登录态

新包会话中:

```
browser_auth action="restore" cookies=<步骤1保存的JSON>
```

> 说明:宿主 userData 目录已从 `dsh-builtin-browser-host` 改为 `dsh-browser-plus-host`
> (host-main.ts `app.setPath('userData', ...)`),因此 cookie 不会自动迁移,必须走一遍 export/import。

## 变更对使用者可见的部分

- 工具新增:`browser_press_key`、`browser_double_click`、`browser_hover`、`browser_upload_file`、`browser_wait_for`、`browser_space`(共 26 个 `browser_*` 工具)。
- **每个 DSH 任务一个独立浏览器窗口**;窗口标题 = space 名(`browser_space label="..."`)。
- JS 对话框自动 accept,记录见 `browser_history`(action `dialog`)。
- Electron 锁定 **42.9.3**(43.4.1 组合器故障,勿升)。

## 重启要求

provider / remote-host / tool-browser 层改动需要**重启 DSH Web** 后生效;`host-main.js` 改动在旧包目录同步后仅回收 Electron 子进程即可(见 `docs/SOAK-CHECKLIST.md` 的完整验证清单)。
