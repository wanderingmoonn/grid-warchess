import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import { createModelProxy } from './server/model-proxy.ts';

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

/** 私有变量只在 Node 服务侧读取，既不 define 到前端，也不使用 VITE_ 前缀。 */
function localModelProxy(): Plugin {
  const middleware = createModelProxy({
    enabled: !inSandbox,
    env: { ...loadEnv('development', process.cwd(), 'DEEPSEEK_'), ...process.env },
  });
  return {
    name: 'local-deepseek-controller',
    configureServer(server) { server.middlewares.use((req, res, next) => { void middleware(req, res, next); }); },
    configurePreviewServer(server) { server.middlewares.use((req, res, next) => { void middleware(req, res, next); }); },
  };
}

export default defineConfig({
  // 相对路径：部署到任何子目录都不会 404
  base: './',
  plugins: [localModelProxy()],
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
