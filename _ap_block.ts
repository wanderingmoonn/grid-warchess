export const AP_CLASS_MOD = {
  /** 骑兵类：机动更省 —— 移动 −5E */
  mounted: { move: -5 },
  /** 车类（攻城器械、装甲车辆）：机动更省 —— 移动 −5E */
  vehicle: { move: -5 },
  /** 近战类：出手更省 —— 攻击 −10E */
  melee: { attack: -10 },
} as const;

export type ApClass = keyof typeof AP_CLASS_MOD;

/**
 * 骑兵类与车类的兵种 id。
 *
 * 为什么不从数值里推：兵种表里没有"骑"这个字段，`move / range / armor`
 * 也推不出来（游骑和弓手一样是 range 2，坦克和火炮的 armor 又差一截）。
 * 这类归属是**设计决定**，写在表里才能被读、被改、被测试点名核对。
 *
 * 漏写的后果是安全的：那个兵按标准价付 E（多花 5 点），不会凭空变强。
 * `test-rules` 里有一条用例专门核对这张表里的 id 都真实存在，
 * 改兵种 id 或写错字会当场变红。
 */
export const MOUNTED_IDS: readonly string[] = [
  // 原版
  'scout', // 斥候
  'knight', // 骑士
  'hussar', // 骠骑兵
  // 时代兵备
  'med_horsearcher', // 骑射手
  'gp_cuirassier', // 胸甲骑兵
  'gp_dragoon', // 龙骑兵
  // 奇想（`kite` 是"游骑"这条**能力**的 id，不是兵种，别抄进来）
  'royal-cavalry', // 皇家骑兵
  'cataphract', // 超级重骑
  'paladin', // 圣骑士
  'wolf-rider', // 狼骑士
  'spider-rider', // 蜘蛛骑士
  'centaur', // 半人马
  'griffin-rider', // 狮鹫骑士
  'dragoon-rider', // 龙骑兵（奇想）
  'cursed-knight', // 诅咒骑士
];

export const VEHICLE_IDS: readonly string[] = [
  // 原版
  'mortar', // 臼炮
  'artillery', // 火炮
  'armoredcar', // 装甲车
  'tank', // 坦克
  // 时代兵备：战车与各类火炮
  'anc_chariot', // 战车
  'anc_ballista', // 弩炮
  'med_trebuchet', // 投石机
  'gp_siegecannon', // 攻城加农炮
  'gp_culverin', // 长管炮
  'ind_trenchmortar', // 战壕迫击炮
  'ind_howitzer', // 榴弹炮
  'ind_railwaygun', // 列车炮
  'ind_landship', // 马克 I 坦克
  'ind_armoredtrain', // 装甲列车
  'mod_atgun', // 反坦克炮
  'mod_katyusha', // 火箭炮
  'mod_heavytank', // 重型坦克
  'mod_spg', // 自行火炮
  'mod_flak', // 高射炮
  'mod_heavy_mortar', // 重型迫击炮
  'mod_supply', // 补给车队
  // 现代 / 现代战争
  'ct_tank', // 坦克（现代）
  'ct_howitzer', // 榴弹炮（现代）
  'ct_recon', // 装甲侦察车
  'cnt_mbt', // 主战坦克
  'cnt_sph', // 自行榴弹炮
  'cnt_mlrs', // 远程火箭炮
];

/**
 * 近战类不写名单，按定义推：**射程 1 的战斗单位**。
 *
 * 两百多个兵种手写一遍不现实，而且"射程 1 就是贴上去打"本来就是它的定义
 * （射程 2 以上是远程，射程 0/建筑不参与）。斥候、民兵、长枪兵都在里面，
 * 骑士也在里面——一个人既可以算骑兵（机动便宜）也可以算近战（出手便宜），
 * 两类**叠加**，这正是规则想要的效果。
 */
function isMelee(def: UnitTypeDef): boolean {
  return def.category === 'combat' && def.range <= 1 && def.domain !== 'water';
}

/** 这个兵种命中哪些类别。界面用它解释"为什么单价不一样" */
export function apClassesOf(def: UnitTypeDef | undefined, id: string): ApClass[] {
  const out: ApClass[] = [];
  if (MOUNTED_IDS.includes(id)) out.push('mounted');
  if (VEHICLE_IDS.includes(id)) out.push('vehicle');
  if (def && isMelee(def)) out.push('melee');
  return out;
}

/**
 * 某个兵种做某件事要多少 E。
 *
 * 顺序是"先减修正、再保底 5"：保底是给以后可能出现的怪兵种留的活口
 * （比如某个扩展给兵挂了一条"移动 −20"），不让 E 变成负数。
 */
export function apActionCost(
  def: UnitTypeDef | undefined,
  id: string,
  action: ApAction,
): number {
  let e = AP_COST[action];
  const modKey = action === 'hold' ? HOLD_USES_MOD : action;
  for (const cls of apClassesOf(def, id)) {
    const mod = AP_CLASS_MOD[cls] as Partial<Record<ApAction, number>>;
    e += mod[modKey] ?? 0;
  }
  return Math.max(5, e);
}

