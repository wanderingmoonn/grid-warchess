/**
 * **对局结果的缓存**（2026-11-27，用户要求）。
 *
 * 为什么要有它：标定一次要跑几百场"6 打 6"，一场 1~2 秒，十几分钟就没了；
 * 而拟合参数要反复搜几百组，每次重跑对局根本等不起。
 * 现在把每场结果落盘到 `data/duel-cache.json`，**跑一次，之后拟合秒出**。
 *
 * ── 缓存键 ────────────────────────────────────────────────
 *
 *   `打法版本 | a | b | n`
 *
 * `打法版本` 是 `POLICY` 常量：**只要改了镜像打法（走位、选目标），必须手动 +1**，
 * 否则会读到旧打法下的数——那种错很难发现（数字都"看起来正常"，只是不对应现在的 AI）。
 *
 * ── 用法 ──────────────────────────────────────────────────
 *
 *   const r = duel('musketeer', 'halberdier', 6);   // 有缓存直接读，没有就跑一场并记下
 *   flushDuelCache();                                // 脚本结束前写盘（也可以靠进程退出钩子）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fight } from './duel.ts';

/** 镜像打法版本：改了 `duel.ts` 的走位/选目标就 +1 */
const POLICY = 2;
const FILE = 'data/duel-cache.json';

export interface DuelResult {
  aLeft: number;
  bLeft: number;
  turns: number;
}

let cache: Record<string, DuelResult> | null = null;
let dirty = false;

const load = (): Record<string, DuelResult> => {
  if (cache) return cache;
  if (!existsSync(FILE)) return (cache = {});
  try {
    cache = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, DuelResult>;
  } catch {
    cache = {};
  }
  return cache;
};

/** 打一场（优先读缓存）。同参数永远同一个结果，因为打法里没有随机数。 */
export function duel(a: string, b: string, n: number, refresh = false): DuelResult {
  const c = load();
  const key = `v${POLICY}|${a}|${b}|${n}`;
  if (!refresh && c[key]) return c[key]!;
  const r = fight(a, b, n);
  c[key] = { aLeft: r.aLeft, bLeft: r.bLeft, turns: r.turns };
  dirty = true;
  return c[key]!;
}

/** 写盘（幂等） */
export function flushDuelCache(): void {
  if (!dirty || !cache) return;
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(cache, null, 0) + '\n');
  dirty = false;
}

process.on('exit', flushDuelCache);
