import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

/**
 * 构建版本号：报告里要带它，否则跨版本的数据混在一起比。
 *
 * 从 package.json 读，而不是读 git —— 发布产物是从 `_publish/` 发出去的，
 * 工作区和线上跑的东西不一定对得上；version 至少是个人工承诺过的标签。
 */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version?: string;
};

/**
 * 发布环境会注入 PORT，反向代理按这个端口找服务，
 * 所以端口必须跟着 PORT 走，不能写死。
 *
 * host 分两种：
 *   - 沙箱/线上：必须绑 0.0.0.0，否则反代进不来；
 *   - 本机开发：只绑 127.0.0.1，不把开发服务暴露到局域网。
 * 用「有没有 PORT」来区分这两种场景，不需要额外开关。
 */
const inSandbox = !!process.env.PORT;
const port = Number(process.env.PORT) || 5178;
const host = inSandbox ? '0.0.0.0' : '127.0.0.1';

export default defineConfig({
  // 相对路径：部署到任何子目录都不会 404
  base: './',
  define: {
    // 用法见 src/core/build-info.ts：那边会兜底成 'dev'
    __APP_VERSION__: JSON.stringify(pkg.version ?? 'dev'),
  },
  server: {
    host,
    port,
    // 端口被占用时直接报错，而不是悄悄换一个让人找不着
    strictPort: true,
    // 反代过来的 Host 头跟本机不一样，不放开会被 Vite 挡掉
    allowedHosts: true,
  },
  preview: {
    host,
    port,
    strictPort: true,
    allowedHosts: true,
  },
});
