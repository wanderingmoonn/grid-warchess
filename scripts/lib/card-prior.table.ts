/**
 * 卡牌先验表（**生成文件，不要手改**）。
 *
 * 生成：2026-11-08　`python scripts/draft-metrics.py e1 e3 e3-turnban --emit-ts`
 * 数据：e1(n=100), e3(n=100), e3-turnban(n=200)
 *
 * resid  = (实胜 − 席位加权期望) / 局数，pp。**不是裸胜率**。
 * shrunk = resid × n/(n+40)，把 n=20 的卡缩到三分之一。
 * factor = 1 + (0.15/0.15) × clamp(shrunk, ±0.15)，
 *          即 shrunk 到 15pp 才顶到满额，最多把选卡分推 ±15%。
 *
 * 已知偏差（改表前先读）：胜率来自 AI 自对弈，AI 不会用的卡会被判弱、
 * 于是更不会被选，永远学不会。
 *
 * unitsDigest 是这批卡的数值指纹（见 core/unit-digest.ts）。**改了任何一个
 * 参与指纹的数字，这张表就自动失效**——运行端会对不上、先验关掉，
 * npm run test:rules 也会红。重生成：npm run draft:prior
 */

export interface CardPriorRow {
  /** 参与统计的局数（只有一方拿到它的局） */
  n: number;
  /** 未收缩的残差（pp，正 = 拿到它比同席位期望多赢） */
  resid: number;
  /** 收缩后的残差（pp） */
  shrunk: number;
  /** 选卡分乘数：1 + clamp(shrunk/span, ±cap) */
  factor: number;
}

export const CARD_PRIOR_META = {
  builtAt: '2026-11-08',
  batches: ['e1', 'e3', 'e3-turnban'],
  games: 400,
  unitsDigest: 'e459218f',
  k: 40.0, span: 0.15, cap: 0.15, minN: 10,
} as const;

export const CARD_PRIOR: Record<string, CardPriorRow> = {
  'musketeer': { n: 82, resid: 0.2587, shrunk: 0.1739, factor: 1.1500 },
  'witch': { n: 94, resid: 0.3147, shrunk: 0.2207, factor: 1.1500 },
  'elf-archer': { n: 49, resid: 0.2176, shrunk: 0.1198, factor: 1.1198 },
  'rifleman': { n: 107, resid: 0.1518, shrunk: 0.1105, factor: 1.1105 },
  'royal-cavalry': { n: 70, resid: 0.1281, shrunk: 0.0815, factor: 1.0815 },
  'cursed-knight': { n: 26, resid: 0.1975, shrunk: 0.0778, factor: 1.0778 },
  'swordsman': { n: 87, resid: 0.0877, shrunk: 0.0601, factor: 1.0601 },
  'paladin': { n: 69, resid: 0.0913, shrunk: 0.0578, factor: 1.0578 },
  'squad': { n: 112, resid: 0.0678, shrunk: 0.0499, factor: 1.0499 },
  'knight': { n: 46, resid: 0.0721, shrunk: 0.0386, factor: 1.0386 },
  'minotaur': { n: 10, resid: 0.1849, shrunk: 0.0370, factor: 1.0370 },
  'halberdier': { n: 70, resid: 0.0573, shrunk: 0.0364, factor: 1.0364 },
  'elite-cavalry': { n: 31, resid: 0.0796, shrunk: 0.0347, factor: 1.0347 },
  'dragoon-rider': { n: 136, resid: 0.0425, shrunk: 0.0328, factor: 1.0328 },
  'ironclad': { n: 74, resid: 0.0474, shrunk: 0.0308, factor: 1.0308 },
  'treant': { n: 97, resid: 0.0289, shrunk: 0.0205, factor: 1.0205 },
  'royal-king': { n: 181, resid: 0.0167, shrunk: 0.0137, factor: 1.0137 },
  'gunboat': { n: 29, resid: 0.0289, shrunk: 0.0121, factor: 1.0121 },
  'cataphract': { n: 101, resid: 0.0166, shrunk: 0.0119, factor: 1.0119 },
  'phoenix': { n: 31, resid: 0.0240, shrunk: 0.0105, factor: 1.0105 },
  'tower_ship': { n: 40, resid: 0.0118, shrunk: 0.0059, factor: 1.0059 },
  'mage': { n: 22, resid: 0.0123, shrunk: 0.0044, factor: 1.0044 },
  'demon': { n: 183, resid: 0.0046, shrunk: 0.0038, factor: 1.0038 },
  'holy-knight-lord': { n: 206, resid: 0.0007, shrunk: 0.0006, factor: 1.0006 },
  'militia': { n: 95, resid: 0.0000, shrunk: 0.0000, factor: 1.0000 },
  'ge': { n: 95, resid: 0.0000, shrunk: 0.0000, factor: 1.0000 },
  'serpent-man': { n: 95, resid: 0.0000, shrunk: 0.0000, factor: 1.0000 },
  'tank': { n: 228, resid: -0.0026, shrunk: -0.0022, factor: 0.9978 },
  'hydra': { n: 177, resid: -0.0045, shrunk: -0.0037, factor: 0.9963 },
  'artillery': { n: 236, resid: -0.0130, shrunk: -0.0111, factor: 0.9889 },
  'bone-dragon': { n: 210, resid: -0.0241, shrunk: -0.0202, factor: 0.9798 },
  'armoredcar': { n: 10, resid: -0.1039, shrunk: -0.0208, factor: 0.9792 },
  'earth-elemental': { n: 103, resid: -0.0314, shrunk: -0.0226, factor: 0.9774 },
  'clockwork-golem': { n: 175, resid: -0.0285, shrunk: -0.0232, factor: 0.9768 },
  'angel': { n: 198, resid: -0.0357, shrunk: -0.0297, factor: 0.9703 },
  'two-head-giant': { n: 93, resid: -0.0436, shrunk: -0.0305, factor: 0.9695 },
  'ogre': { n: 85, resid: -0.0505, shrunk: -0.0344, factor: 0.9656 },
  'dwarf-king': { n: 94, resid: -0.0892, shrunk: -0.0626, factor: 0.9374 },
  'alchemist': { n: 25, resid: -0.1631, shrunk: -0.0627, factor: 0.9373 },
  'bunker': { n: 25, resid: -0.1797, shrunk: -0.0691, factor: 0.9309 },
  'battery': { n: 91, resid: -0.1000, shrunk: -0.0694, factor: 0.9306 },
  'mortar': { n: 69, resid: -0.1124, shrunk: -0.0711, factor: 0.9289 },
  'spearman': { n: 74, resid: -0.1117, shrunk: -0.0725, factor: 0.9275 },
  'slime-boss': { n: 38, resid: -0.1503, shrunk: -0.0732, factor: 0.9268 },
  'night-necromancer': { n: 56, resid: -0.1337, shrunk: -0.0780, factor: 0.9220 },
  'troll': { n: 38, resid: -0.1764, shrunk: -0.0859, factor: 0.9141 },
  'royal-guard': { n: 144, resid: -0.1444, shrunk: -0.1130, factor: 0.8870 },
  'witch-doctor': { n: 58, resid: -0.1966, shrunk: -0.1163, factor: 0.8837 },
  'crossbow': { n: 40, resid: -0.3789, shrunk: -0.1895, factor: 0.8500 },
};
