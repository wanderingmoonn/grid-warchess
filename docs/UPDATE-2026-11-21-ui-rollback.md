# v0.9.104 · UI 更新与经典界面回退

2026-11-21 已通过 WorkBuddy 的原站发布工具更新同一应用，域名与分享码保留：

https://grid-warchess-76858.app.workbuddy.host/?sharecode=JXRGIZAHUH

包含三批 UI 调整与回退入口。首页右上角或「设置 → 外观 → 界面回滚」可切换经典首页、棋子和手机布局，也可恢复新版。对局进度与交锋预览保留。布局选择记入本机偏好，应急入口为原链接附加 `&layout=classic`。

## 发布验证

- 339 项界面测试、11 项本地静态服务测试、类型与构建、CSS 与对比度检查通过。
- 原链接与应急入口均返回 HTTP 200，线上引用下列 v0.9.104 文件。
- 线上 JS、CSS 下载后的 SHA256 与已验证的独立发布包逐字节一致。
- 云服务按需加载模块返回 HTTP 200。
- 线上 `__health` 路由未通过（带分享码为 404）；本次线上可用性验证使用实际首页与资源响应，不把该路由计为通过。

| 文件 | SHA256 |
| --- | --- |
| `assets/index-2r353Z3B.js` | `6445A26FD04D64606FB16B0188F1852C151F7E9167BC42AD753035716CCC8928` |
| `assets/index-DUXRlmG3.css` | `76644C55DE082B42089AB87EFC5AAF7A5FBCA29C9243F70AE7CE0503D766C612` |

独立发布包在 `.tmp/ui-rollback-release-v0.9.104/`；构建前的本地产物入口与 assets 保留于 `.tmp/release-backup-before-ui-rollback-20261121/`。WorkBuddy 核对项目 `_publish/` 与独立包一致后，使用绑定原应用的目录更新，避免新建应用改变链接。本次未提交或推送 Git。
