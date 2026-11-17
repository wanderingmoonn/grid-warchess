/**
 * 主线 / 教学关（菜单的「关卡」栏）——**这里放的是关卡 JSON，不是代码**。
 *
 * 加一关的四步：
 *   1. 在审核台把那关卡「下载 JSON」；
 *   2. 存成 `src/levels/story/ch-01.json`（文件名随意，会当关卡名用不上）；
 *   3. 下面加两行 import，把对象塞进 `STORY_RAW`；
 *   4. 提交。下一版发布之后，所有玩家的「关卡」栏就有它了——离线也能玩。
 *
 * 为什么是显式 import 而不是 `import.meta.glob`：core 要同时跑在浏览器（Vite）
 * 和 `node --experimental-strip-types`（探针 / 规则测试），glob 只有前者认。
 * 代价是加一关要加一行——本来"往主线里加内容"也该是一次有意识的提交。
 *
 * 校验在 `level.ts` 的 `storyList()` 里做：每条都过 `validateLevel`，
 * 坏的那一条**跳过并记日志**，不让一份手改坏的 JSON 把整个游戏打不开。
 */
import type { LevelDef } from '../../core/level.ts';

/**
 * 原始数据（未校验）。每条都应当是一份完整的关卡 JSON。
 *
 * 加关的写法：
 * ```ts
 * import ch01 from './ch-01.json' with { type: 'json' };
 * export const STORY_RAW: unknown[] = [ch01];
 * ```
 */
export const STORY_RAW: unknown[] = [];

/** 类型留个出口：这几份数据在运行时就是 `LevelDef`，只是还没过校验 */
export type StoryLevel = LevelDef;
