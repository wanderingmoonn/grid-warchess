/**
 * 云端连接信息。
 *
 * 这三个值就是开通云服务时后端下发的 publicConfig，原样搬过来：
 *   - endpoint 是本应用的**发布域名**，服务端对它做**精确 Origin 校验**，
 *     所以它必须等于你实际打开这个游戏的那条域名，一个字都不能差。
 *   - publishableKey 只标识"是哪个应用"，本身不带任何权限，
 *     放在前端源码里是设计允许的。
 *   - 真正的后端凭据只存在于服务端，永远不会下发到浏览器。
 *
 * ⚠️ 这一块是"换域名发布"唯一会静默弄坏的地方，务必记住因果：
 *
 *   endpoint / publishableKey 是**跟着应用绑定**的，不是跟着代码。
 *   一旦发布了新应用（或者把应用挪到别的域名），云端就在另一边换了一套：
 *   地址变了、密钥也换了。而前端这两行还在指着旧的那套，表现出来是
 *   **房间建不出来 / 进不去**——并且两边看到的是同一句话，因为两边都在
 *   犯同一个错。2026-10-27 的事故就是这么来的：
 *
 *     代码里写着  grid-warchess-04934  + wbpk_3d67…
 *     实际发布在  grid-warchess-76858  + wbpk_fUY7…
 *
 *   两个都不对：旧域名对这张密钥返回 403（Origin 不匹配），旧密钥对任何
 *   域名返回 401（invalid_client）。SDK 把这类失败包装成一个既没有 code、
 *   也没有 message 的错误对象，于是界面只能落到兜底文案"网络不通，稍后再试"，
 *   看起来像网络问题，其实是一行配置过期。
 *
 * 所以：**换域名发布之后，第一件事是回来核对这两行。**
 * 拿法：让云服务面板（或 cloud-service 的 inspect/activate）把 publicConfig
 * 再下发一次，把 endpoint 和 publishableKey 原样贴回来。
 * 核对手段：打开「联机」面板，顶上那条自检会直接把"连上了 / 域名不对 /
 * 密钥失效 / 房间表不存在"分开报出来，不用再靠猜。
 */

export const CLOUD_CONFIG = {
  endpoint: 'https://grid-warchess-76858.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_fUY7GgSFcMVuqHwAfJD668_WqJTgVrvy566sD4dopAAILAGXln4TIIA',
} as const;
