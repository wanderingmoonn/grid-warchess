/**
 * 战后金币结算。
 *
 * 设计前提：**没有城市收入、也不造经济单位**（2026-11-19 定），金币只有一个来源
 * ——战果。所以这个公式实质上是"这一关打得好不好"的度量，常数集中在这里，
 * 调数值不用改逻辑。
 */

export interface SettleInput {
  /** 第几关（0 起） */
  stageIndex: number;
  /** 撤离时带进城的人数 */
  taken: number;
  /** 相对"期望手数"省下几手（负数按 0 算） */
  turnsSaved: number;
  /** 拆掉了营地/前哨 */
  campDestroyed: boolean;
  /** 没清场就主动结束（败退） */
  halfDone: boolean;
}

/** 常数：全部是占位数，按兵种造价（长弓 90 这个量级）校准 */
export const SETTLE = {
  /** 基础：第 1 关 40，之后每关 +40 */
  base: 40,
  basePerStage: 40,
  /** 每带走一个人 */
  perUnit: 15,
  /** 每省一手 */
  perTurn: 8,
  /** 提前结束的额外奖励上限 */
  turnCap: 40,
  /** 拆营地 */
  camp: 60,
  /** 败退只拿三成 */
  retreatRate: 0.3,
} as const;

/**
 * 升一级城市时代要多少钱。
 *
 * 递增而不是定额：时代是**质变**（兵种池整体换代），定额会让"先攒钱直冲三代"
 * 变成唯一解。递增逼玩家在"升时代 / 练兵 / 修城"之间排队。
 */
export const CITY_UPGRADE = { base: 140, step: 90 } as const;

export function cityUpgradeCost(currentEra: number): number {
  const era = Math.max(1, Math.floor(currentEra));
  return CITY_UPGRADE.base + CITY_UPGRADE.step * (era - 1);
}

export function settleGold(input: SettleInput): number {
  const base = SETTLE.base + SETTLE.basePerStage * Math.max(0, input.stageIndex);
  const units = Math.max(0, input.taken) * SETTLE.perUnit;
  const early = Math.min(Math.max(0, input.turnsSaved) * SETTLE.perTurn, SETTLE.turnCap);
  const camp = input.campDestroyed ? SETTLE.camp : 0;
  const gross = base + units + early + camp;
  // 败退：保底给三成，避免"一次打崩就再无资金来源"的静默死亡
  const gold = input.halfDone ? Math.floor(gross * SETTLE.retreatRate) : gross;
  return Math.max(0, Math.round(gold));
}
