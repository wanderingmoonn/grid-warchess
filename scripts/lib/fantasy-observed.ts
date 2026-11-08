/**
 * 奇想兵种"实测"数据的唯一入口：出场次数、交换比、以及 AI 真正在用的那把尺子。
 *
 * 为什么要单独一个文件：`fantasy-table.ts`（看数值）和 `fantasy-overlap.ts`
 * （看挤占）都要这几样东西，各写一份的结果是——改一处、另一处悄悄过期。
 * 2026-11-07 就撞过一次：旧评分表里的"性价比"指数还是 0.95，代码早改成 0.55，
 * 两张表并排摆着，数不一样，读的人只会以为哪边算错了。
 *
 * 数据来源（本文件不跑对局，只读现成的跑批产物）：
 *   results/bf-modern*  四批双 AI 跑批，共 400 局
 *     · 200 局火药开局（era3）  · 200 局信息化开局（era6）
 *     · 20×20，扩展含现代 + 奇想，回合上限 200
 *   两批必须都要：皇家骑兵只在火药批出现（62/0），圣剑勇者只在信息化批出现（23/421）。
 */
import { readFileSync } from 'node:fs';

/** 火药开局那两批（era3） */
export const BATCH_ERA3 = [
  'results/bf-modern/merged-era3.json',
  'results/bf-era3b/merged-era3.json',
] as const;

/** 信息化开局那两批（era6） */
export const BATCH_ERA6 = [
  'results/bf-modern6/merged-era6.json',
  'results/bf-modern6b/merged-era6.json',
] as const;

/** 每批的局数。上面四条路径各 100 局，两条一批 */
export const GAMES_PER_BATCH = 100;

export interface Observed {
  /** 火药批建造次数 */
  b3: number;
  /** 信息化批建造次数 */
  b6: number;
  /** 两批合计 */
  built: number;
  /** 出场人次（含召唤、分裂、孵化） */
  seen: number;
  dealt: number;
  taken: number;
  kills: number;
  /** 输出 / 承伤；没挨过打就是 0 */
  ratio: number;
}

export const EMPTY_OBS: Observed = {
  b3: 0,
  b6: 0,
  built: 0,
  seen: 0,
  dealt: 0,
  taken: 0,
  kills: 0,
  ratio: 0,
};

type StatsRow = {
  type: string;
  built?: number;
  seen?: number;
  dealt?: number;
  taken?: number;
  kills?: number;
};

function sumBatches(files: readonly string[]): Map<string, Observed> {
  const out = new Map<string, Observed>();
  for (const p of files) {
    let j: { stats?: StatsRow[] };
    try {
      j = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      // 没跑过这一批就跳过：表里那一格会显示 0，读者要能从"两边都是 0"里
      // 读出"没有样本"，而不是"这个兵一次都没被造"
      continue;
    }
    for (const st of j.stats ?? []) {
      const c = out.get(st.type) ?? { ...EMPTY_OBS };
      c.built += st.built ?? 0;
      c.seen += st.seen ?? 0;
      c.dealt += st.dealt ?? 0;
      c.taken += st.taken ?? 0;
      c.kills += st.kills ?? 0;
      out.set(st.type, c);
    }
  }
  for (const v of out.values()) v.ratio = v.taken > 0 ? v.dealt / v.taken : 0;
  return out;
}

let cache: Map<string, Observed> | null = null;

/** id → 出场/战斗。第一次调用时读盘，之后走缓存（两个脚本各调一次，无所谓） */
export function observed(): Map<string, Observed> {
  if (cache) return cache;
  const era3 = sumBatches(BATCH_ERA3);
  const era6 = sumBatches(BATCH_ERA6);
  const out = new Map<string, Observed>();
  for (const id of new Set([...era3.keys(), ...era6.keys()])) {
    const a = era3.get(id) ?? EMPTY_OBS;
    const b = era6.get(id) ?? EMPTY_OBS;
    out.set(id, {
      b3: a.built,
      b6: b.built,
      built: a.built + b.built,
      seen: a.seen + b.seen,
      dealt: a.dealt + b.dealt,
      taken: a.taken + b.taken,
      kills: a.kills + b.kills,
      ratio: a.taken + b.taken > 0 ? (a.dealt + b.dealt) / (a.taken + b.taken) : 0,
    });
  }
  cache = out;
  return out;
}

/**
 * 旧尺子——**AI 采购默认用的就是这一把**，不是 `unit-value.ts`。
 *
 * 公式抄自 `ai.ts` 的 `oldPower` / `oldEfficiency`（那里没导出，只能复写）。
 * 抄它的理由：讨论"为什么没人买"时，必须看 AI 真正读的那一列；
 * 只写新尺子就会出现"性价比高却零出场"的假象——其实是两把尺子不同源。
 * **改 `ai.ts` 那把尺子时，这里要跟着改**，否则表会说谎。
 *
 * 它的三个特征决定了奇想表的形状：
 *   · 只读 攻 / 魔攻 / 血 / 射程——移速、视野、能力一概不算钱；
 *   · 价格指数 0.8（新尺子是 0.55），贵一点掉得更多；
 *   · 射程每格 +45%（封顶 4 格），远程兵天然占便宜。
 */
export const oldPower = (d: { atk: number; magicAtk?: number; maxHp: number; range?: number }): number =>
  (d.atk + (d.magicAtk ?? 0) * 1.2) *
  Math.sqrt(d.maxHp) *
  (1 + Math.min(4, Math.max(0, (d.range ?? 1) - 1)) * 0.45);

export const oldEfficiency = (
  d: { atk: number; magicAtk?: number; maxHp: number; range?: number },
  price: number,
): number => oldPower(d) / Math.max(20, price) ** 0.8;

/**
 * 兵种属于原五个子包里的哪一个。
 *
 * 2026-11-04 五个包并成了一个「奇想」，`expansion.units` 里已经看不出分组，
 * 但分组本身仍有信息量（荒兽偏厚、秘法偏法术、骑士团偏人）。
 * 从源文件的分段里读回来，比在别处再维护一份 id 清单可靠。
 */
export function packMap(): Map<string, string> {
  const src = readFileSync('src/core/fantasy-packs.ts', 'utf8').split(/\r?\n/);
  const at = (re: RegExp): number => src.findIndex((l) => re.test(l));
  const spans: [string, number, number][] = [
    ['骑士团', at(/^const KNIGHTS: Expansion/), at(/^const BEASTS: Expansion/)],
    ['荒兽', at(/^const BEASTS: Expansion/), at(/^const ARCANE: Expansion/)],
    ['秘法', at(/^const ARCANE: Expansion/), at(/^const HERO_UNITS/)],
    ['英雄', at(/^const HERO_UNITS/), at(/^export const FANTASY: Expansion/)],
  ];
  const out = new Map<string, string>();
  for (const [name, a, b] of spans) {
    for (let i = a; i < b; i++) {
      const m = /^\s+id: '([a-z0-9-]+)',$/.exec(src[i] ?? '');
      // 下一行必须是 name/cost/era，才认这是兵种定义（能力表里也有 id）
      if (m && /^\s+(name|cost|era):/.test(src[i + 1] ?? '')) out.set(m[1]!, name);
    }
  }
  return out;
}
