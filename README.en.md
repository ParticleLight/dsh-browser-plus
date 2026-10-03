# dsh-browser-plus

> A visible browser runtime for DeepSeek Harness. Humans and agents operate the same real page, not a headless replay or screenshot proxy.

dsh-browser-plus is developed on top of the MIT-licensed `dsh-browser` codebase and independently maintained by ParticleLight.

[![awesome · DSH plugin](https://img.shields.io/badge/awesome%20%C2%B7%20DSH%20plugin-%E2%9C%94-red?style=flat&labelColor=white)](#)
[![npm](https://img.shields.io/npm/v/dsh-browser-plus?style=flat&label=npm&color=blue)](https://www.npmjs.com/package/dsh-browser-plus)
[![downloads](https://img.shields.io/npm/dm/dsh-browser-plus?style=flat&label=downloads&color=blue)](https://www.npmjs.com/package/dsh-browser-plus)
[![GitHub Stars](https://img.shields.io/github/stars/ParticleLight/dsh-browser-plus?style=flat&label=Stars&logo=github)](https://github.com/ParticleLight/dsh-browser-plus)
[![license](https://img.shields.io/github/license/ParticleLight/dsh-browser-plus?style=flat&label=license&color=green)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/ParticleLight/dsh-browser-plus/ci.yml?branch=main&style=flat&label=CI&logo=github)](https://github.com/ParticleLight/dsh-browser-plus/actions)
[![DSH](https://img.shields.io/badge/DSH-0.1.0--rc.1%20%7C%7C%200.2.0--rc.1-blue?style=flat)](#)
[![status](https://img.shields.io/badge/status-stable-green?style=flat)](#)

## Why it exists

Browser automation should not disappear into a process the user cannot inspect. dsh-browser-plus keeps the browser window visible while giving agents reliable CDP control.

- **Visible by default**: a real Electron `WebContentsView`, not a headless relay.
- **Task isolation**: all DSH sessions share one visible window while keeping isolated task views, tabs, and history; the page task manager switches the visible view, and `browser_space` names browser tasks.
- **Human handoff**: page chrome, bookmarks, the task workspace, operation trail, and user activity detection live on the real page; a user can take control of the active task and explicitly return it to the agent.
- **Task workspace**: task and operation trail are independent opaque panels (Chrome menu surface, `#292a2d`) that can stay open together. Each task exposes running, waiting-user, human-control, failed, or idle state. Thumbnails refresh on demand only while the task panel is open; background tasks retain their last image.

![dsh-browser-plus task workspace](assets/readme-workspace.png)

- **Physical input**: keyboard, mouse, hover, double-click, and file selection use CDP instead of synthetic `element.click()` events.
- **Recovery-aware**: a recycled child re-materializes the same session view; the first recovered capture waits for compositor readiness.
- **Stable baseline**: Electron 42.9.3 is pinned; the resolver rejects Electron 43.4.1 because of compositor failures.

## Install

From npm (recommended):

```sh
dsh plugin --profile web add dsh-browser-plus
```

Or straight from the repository:

```sh
dsh plugin --profile web add github:ParticleLight/dsh-browser-plus
```

If another browser bundle is already installed, read the [migration guide](docs/MIGRATION.md), then restart DSH Web.

## Main capabilities

| Scenario | Tools |
| --- | --- |
| Open and inspect | `browser_open`, `browser_snapshot`, `browser_content`, `browser_screenshot` |
| Native navigation | `browser_back`, `browser_forward`, `browser_reload`, `browser_stop`, `browser_scroll` |
| Snapshot references | `browser_click_ref`, `browser_scroll_into_view` |
| Page interaction | `browser_click`, `browser_press_key`, `browser_double_click`, `browser_hover`, `browser_type` |
| Forms and files | `browser_fill`, `browser_upload_file`, `browser_wait_for` |
| Tasks and handoff | `browser_tasks`, `browser_handoff`, `browser_list_tabs`, `browser_switch_tab`, `browser_close_tab`, `browser_space` |
| Auth and recovery | `browser_auth`, `browser_reset_session`, `browser_history` |
| Dialogs | `browser_dialog` |
| Diagnostics | `browser_console`, `browser_network` |
| Device emulation | `browser_emulate` |
| Dragging | `browser_drag` |
| Page scripts | `browser_execute` |
| Bulk scraping | `browser_scrape` |
| Downloads | `browser_download` |
| Replay | `browser_replay` |
| Bot checks | `browser_challenge` |
| Action allow-list | `browser_restrict` |
| Session | `browser_session`, `browser_reset` |

Snapshots expose a short-lived `snapshotId` plus element references. Prefer reference tools and take a fresh snapshot after the page changes; page-level scripts automatically ignore the browser's own chrome.

## How it works

```text
browser_* tools
  -> BrowserRuntime (ctx.browser seam)
  -> ElectronBrowserProvider (CDP)
  -> RemoteElectronViewHost (loopback JSON-RPC)
  -> host-main.js (BrowserWindow + WebContentsView)
```

The chrome and task manager are injected through a closed Shadow DOM rather than a second Electron view. Versioned incremental workspace updates keep task and trail rendering light while background task updates stay isolated and do not steal the user's visible page.

`alert`, `confirm`, and `prompt` are accepted immediately **by default** so pages do not block, and the detail is recorded as a `dialog` item in `browser_history`. To drive a page that confirms a destructive action, set how the NEXT dialog is answered with `browser_dialog` (`accept` / `dismiss`, with `promptText` for `prompt()`) and then trigger it; `inspect` reports the last one.

## Reliability rules

1. Never reparent a visible `WebContentsView`.
2. The CDP capture fallback only touches siblings in the same window and restores them.
3. Native and full-page capture wait once for compositor readiness after child recovery.
4. Dialogs, captures, dynamic waits, and child recovery have regression tests and live SOAK coverage.

See [SOAK-CHECKLIST](docs/SOAK-CHECKLIST.md) for the complete runtime verification list.

## Development

```sh
npm install
npm run build
npm test
npm run smoke:electron-host # requires a local DSH Web instance; validates real Electron Host navigation and page handoff
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution rules, [docs](docs/README.md) for the full documentation set, and [CHANGELOG](CHANGELOG.md) for version history.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE.md).
