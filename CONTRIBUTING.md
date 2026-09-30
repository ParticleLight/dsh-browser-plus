# Contributing

感谢对这个插件的兴趣!

## 开发环境

```sh
npm install
npm run build
npm test          # 先自动 tsc(pretest),再跑 test/*.test.mjs
npm run test:only # 跳过构建,仅跑测试(要求 lib/ 已是最新)
npm run lint      # ESLint(类型感知的最小集)
```

## 约定

- TDD:先写失败测试(`test/provider-actions.test.mjs` 用 FakeHost 断言 CDP 调用序列;`host-composition.test.mjs` 为源码断言,保护 host 线序)。
- **铁律**:
  1. 永不 reparent 可见 WebContentsView(唯一例外:capture 的 CDP 回退,临时 detach 同窗口视图且必须恢复)。
  2. 页面 chrome 留在页面内(closed Shadow DOM);不得变成第二个 WebContentsView。
  3. Electron 锁 42.9.3(43.4.1 组合器故障);升级需 5/5 导航浸泡测试。
  4. 快照/填充/内容脚本必须过滤 `closest('[data-dsh-browser-chrome]')`。
- 测试从 `lib/` 导入构建产物,因此 `npm test` 由 `pretest` 前置 `tsc`;**手工 `node --test` 前必须先 `npm run build`**,否则测的是旧 `lib/`。
- 提交信息风格:`feat/fix|test(scoped): ...`,每个任务独立提交。

## 运行时验证

改动 `host-main.js`/`page-chrome.js` 后需重启浏览器子进程;改动 provider/remote/tool 层后需重启 DSH(见 `docs/SOAK-CHECKLIST.md`)。

## 发布

`package.json` 声明 `dsh.bundle.patch`(已就绪);发布 = 打 tag + `npm pack` + `gh release create`。
