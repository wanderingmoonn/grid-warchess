/**
 * 采购打分探针：复刻 ai.recruitCandidate 的打分（只复刻固定项），
 * 用来看"为什么这个兵一局都没人造"。
 *
 * 它不参与游戏，也不改任何状态之外的东西，纯粹是一把尺子：
 * 把当前局面下所有可买兵种按 AI 的分数排一遍。改完 ai.ts 记得重跑，
 * 因为这里是**复刻**——两边不一致时，以 ai.ts 为准，把这个文件对齐上去。
 *
 *   npm run probe:score
 */
import { createMatch } from '../src/core/setup.ts';
import { applyAction } from '../src/core/rules.ts';
import { aiNextAction, aiNoise, aiTraits } from '../src/core/ai.ts';
import { recruitCost, unitsOf } from '../src/core/rules.ts';
import { UNIT_TYPES } from '../src/core/config.ts';

const F = ['fantasy-core','fantasy-knights','fantasy-beasts','fantasy-arcane','fantasy-heroes'];
let s: any = createMatch({ size: 12, startEra: 3, aiOpponent: false, aiAlly: true, expansionIds: F, enabledUnits: Object.keys(UNIT_TYPES), aiLevel: 'advanced' } as any, 4242);
s.players.A.gold = 400;
// 走几步让局面正常化
for (let i = 0; i < 10; i += 1) {
  const a: any = aiNextAction(s);
  if (!a) break;
  const r: any = applyAction(s, a);
  if (!r.ok) break;
  s = r.state;
  s.players.A.gold = 400;
  i += 0;
}

const me = 'A';
const myUnits = unitsOf(s, me);
const combat = myUnits.filter((u: any) => s.unitTypes[u.type].category === 'combat');
const land = myUnits.filter((u: any) => s.unitTypes[u.type].category === 'combat' && s.unitTypes[u.type].domain !== 'water');
const rangedShare = land.length ? land.filter((u: any) => s.unitTypes[u.type].range >= 3).length / land.length : 0.5;
const srcEra = 3;
const traits = aiTraits(s);
const gold = s.players.A.gold;

const rows: any[] = [];
for (const d of Object.values(s.unitTypes) as any[]) {
  if (d.category !== 'combat') continue;
  if (d.summonedOnly || d.transport) continue;
  if (d.era > srcEra || d.era < srcEra - 1) continue;
  const price = recruitCost(s, me, d);
  if (gold < price) continue;
  let score = 50;
  score += 12 + d.era * 4;
  if (d.era >= 4) score += 6 + (d.era - 4) * 6;
  if (d.range >= 3) score += rangedShare < 0.7 ? 9 : -5;
  else if (d.range === 2) score += rangedShare < 0.7 ? 1 : 3;
  else score += rangedShare < 0.7 ? -4 : 7;
  const raider = d.move >= 4 && d.range <= 3;
  if (raider) score += 7;
  const support = (d.abilities ?? []).some((a: string) => ['aura-command','aura-armor','fear'].includes(a));
  if (support) score += 5;
  if (d.hero && gold >= price + (d.unlockCost ?? 0) + 120) score += 14;
  if (land.length < 4 && price <= 80) score += 8;
  score -= Math.min(38, combat.length * 1.6);
  score -= (srcEra - d.era) * 11;
  score -= price * 0.035;
  if (traits.favorites.includes(d.id)) score += 9;
  score += (aiNoise(s, d.id.length * 31 + d.id.charCodeAt(0)) - 0.5) * 4;
  rows.push({ name: d.name, id: d.id, era: d.era, cost: price, atk: d.atk, magic: d.magicAtk ?? 0, rng: d.range, score });
}
rows.sort((a, b) => b.score - a.score);
console.log(`局面：combat=${combat.length} land=${land.length} rangedShare=${(rangedShare*100).toFixed(0)}% gold=${gold}`);
console.log('排名  兵种      时代 造价 攻 魔攻 射程  分数');
rows.forEach((r, i) => console.log(`${String(i + 1).padStart(3)}  ${r.name.padEnd(8)} ${r.era}  ${String(r.cost).padStart(4)} ${String(r.atk).padStart(3)} ${String(r.magic).padStart(4)} ${String(r.rng).padStart(3)}  ${r.score.toFixed(1)}`));
