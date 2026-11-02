declare module '*.css';

/**
 * 构建版本号，由 vite.config.ts 从 package.json 注入。
 *
 * 只在 `vite build` / `vite dev` 的产物里有值；脚本（node --experimental-strip-types
 * 直接跑 .ts）里没有这次替换，读到的是 undefined——所以读取一律走 core/build-info.ts
 * 的 `BUILD_VERSION`，别在别处直接引用这个全局量。
 */
declare const __APP_VERSION__: string;
