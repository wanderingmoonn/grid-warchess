/**
 * 异象：修士突破境界时天象外泄，位置被敌方看见。
 *
 * ## 为什么要有这个
 *
 * 修士是"滚雪球"兵种：前期弱、后期能一打三。所以它必须有一个前期代价——
 * 你每突破一次，就在敌方视野里点一盏灯，写着"我在这儿"。对面因此有动力
 * 在它还小的时候来劫杀，而不是等它长起来。
 *
 * ## 它到底做了什么（以及为什么只能这么做）
 *
 * 引擎里"被看见"只有一条通路：`playerView` 会把不在 `visibleSet` 里的敌方单位
 * 整个裁掉（`fog.ts` 开头那段"不是自己的东西不下发"）。留痕也一样，
 * `visibleMarks` 要求 `inSight(i)`。
 *
 * 所以"点亮一格"在架构上只有一个含义：**把那一格塞进敌方的可见集**。
 * 这里通过 `ExpansionHooks.extraVision` 返回格索引，由 `visibleTilesOf`
 * 合并进去——于是敌方的 UI 看得见、AI 也看得见（能据此寻路和开火）。
 * 只放一个特效元素是没用的：对面手里连那一格的数据都没有。
 *
 * ## 时机
 *
 * - 突破发生在自己回合 → 记下**突破时所在格**（不是"当前位置"，见下）；
 * - 只在**敌方自己的回合**里点亮（`s.current === 敌方`），所以 A 回合突破，
 *   到 B 的回合才亮；B 回合结束就熄。
 * - 三人四人局里，点亮的是"紧接着行动的那一家"，不需要回合号。
 *
 * ## 为什么记坐标、不跟随
 *
 * 跟着兵走等于给对面一整个回合的真视，前期升一级才 10 点经验，
 * 会变成"一升级就被追着打一整回合"。记坐标则是"痕迹"：修士突破后原地不动，
 * 对面就直接看见它；跑了，就只剩一个点的位置信息。这也更像"异象"而不是雷达。
 *
 * ## 一个刻意的选择：刚挂上那一次不算
 *
 * 异象在 rank 1 挂上（见 `abilities/unlocks.ts` 的触发表）。0→1 那次突破
 * 是**它刚获得异象的那一次**，此时它还没有这个"体质"，所以不点亮。
 * 判定写成 `rank > ANOMALY_MIN_RANK` 而不是"查身上有没有这个能力"——
 * 后者取决于"解锁监听"和"异象监听"谁先注册，是隐式顺序依赖。
 */
import type { AbilityDef } from '../../abilities.ts';
import type { GameState, PlayerId, Unit } from '../../types.ts';
import { getRank, onRankUp } from '../progression.ts';
import { isCultivatorUnit, ANOMALY_ABILITY_ID } from '../identity.ts';

/** 从几级开始挂异象（含本级：1 级就挂上，但 0→1 那次不点亮，见文件头） */
export const ANOMALY_MIN_RANK = 1;

export const ANOMALY_NAME = '异象';

/** 异象记的是"突破时那一格" */
export interface AnomalySpot {
  x: number;
  y: number;
}

/** 这个单位身上有待生效的异象吗 */
export function anomalySpotOf(u: Unit): AnomalySpot | undefined {
  const raw = u.custom?.anomaly as AnomalySpot | undefined;
  if (!raw) return undefined;
  if (typeof raw.x !== 'number' || typeof raw.y !== 'number') return undefined;
  return raw;
}

/** 记一次异象（覆盖旧的：连着突破只亮最新那一次的位置） */
function markAnomaly(u: Unit): void {
  u.custom = { ...(u.custom ?? {}), anomaly: { x: u.x, y: u.y } satisfies AnomalySpot };
}

/**
 * 给 player 看的异象格（格索引）。
 *
 * 只在该玩家**自己的回合**返回东西：这样 A 回合突破不会让 B 在自己的界面上
 * 立刻看到（B 那一刻不在行动，看到也没法劫杀），等轮到 B 才亮。
 * 别的玩家一律空手而归——这一行也是热路径上的早退，绝大多数调用走这里就返回。
 */
export function anomalyCellsFor(s: GameState, p: PlayerId): number[] {
  if (s.current !== p) return [];
  const out: number[] = [];
  for (const u of s.units) {
    if (u.owner === p) continue;
    if (!isCultivatorUnit(s, u)) continue;
    const spot = anomalySpotOf(u);
    if (!spot) continue;
    if (spot.x < 0 || spot.y < 0 || spot.x >= s.w || spot.y >= s.h) continue;
    out.push(spot.y * s.w + spot.x);
  }
  return out;
}

/**
 * 某一方回合结束时，把**别人的**异象清掉。
 *
 * 必须是 `u.owner !== endedPlayer`：突破发生在自己回合，如果自己回合结束也清，
 * 那盏灯还没等到敌方回合就被自己掐了。
 * 敌方回合结束才清——正好对应"只亮一个敌方回合"。
 */
export function clearAnomaliesOfOthers(s: GameState, endedPlayer: PlayerId): void {
  for (const u of s.units) {
    if (u.owner === endedPlayer) continue;
    if (!anomalySpotOf(u)) continue;
    const next = { ...(u.custom ?? {}) };
    delete next.anomaly;
    u.custom = next;
  }
}

export const ANOMALY: AbilityDef = {
  id: ANOMALY_ABILITY_ID,
  name: ANOMALY_NAME,
  summary:
    `突破境界时天象外泄：下一个敌方回合，突破时所在格会被点亮，` +
    `敌人能看见那一格（你还在原地的话，连人带位置一起暴露）。`,
  group: 'support',
  // 不带钩子是有意的：ability 的 onTurnStart 只在**自己回合**触发，
  // 而异象要作用在敌方回合。真正的时机在 hooks.ts 的 extraVision / onTurnEnd。
};

/**
 * 突破时记一笔。
 *
 * 判定用 `rank > ANOMALY_MIN_RANK` 而不是"身上有没有这个能力"：
 * 解锁监听和本监听谁先跑取决于 import 顺序，查能力会变成隐式顺序依赖。
 * 见文件头"刚挂上那一次不算"。
 */
onRankUp((u, s) => {
  if (!isCultivatorUnit(s, u)) return;
  if (getRank(u) <= ANOMALY_MIN_RANK) return;
  markAnomaly(u);
});
