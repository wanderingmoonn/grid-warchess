/**
 * 云端连接信息。
 *
 * 这三个值就是开通云服务时后端下发的 publicConfig，原样搬过来：
 *   - endpoint 是本应用的发布域名，服务端会做严格 Origin 校验，
 *     所以换域名发布时这块必须跟着换，不能随手改。
 *   - publishableKey 只标识"是哪个应用"，本身不带任何权限，
 *     放在前端源码里是设计允许的。
 *   - 真正的后端凭据只存在于服务端，永远不会下发到浏览器。
 *
 * 2026-10-26：这已经是第三次搬家了。应用从 grid-warchess 到
 * grid-warchess-76858，再到现在的 grid-warchess-04934，
 * 每换一次域名，云服务就得在新应用上重新开通、重新建表，
 * endpoint 和 publishableKey 一起换，旧的那组立刻失效。
 *
 * 记住这个因果：**发布到新应用 = 换了一套全新的空数据库**。
 * 忘掉这一步的表现就是"房间建不出来"，而不是任何报错弹窗。
 * 数据表 warchess_rooms 在新库里重建过（RLS 允许 anon 读写，
 * 房间码本身就是通行证），旧库里的房间没有迁过来。
 *
 * 注意：这里没有登录体系。房间码就是通行证——
 * 谁能拼出代码谁就能进这局，这正是"发代码给同学"想要的效果。
 */

export const CLOUD_CONFIG = {
  endpoint: 'https://grid-warchess-04934.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_3d67Uu2UqsgDoaXJbBaFUZ_YBmGQV9gu8LQkZgxh2UawHn2nIlNZBYv',
} as const;
