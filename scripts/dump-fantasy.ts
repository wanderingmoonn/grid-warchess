/**
 * 把奇想兵种包倒成一份 JSON，给 export-fantasy-xlsx.py 做 Excel。
 *
 * 为什么不手抄进表格：六十多个兵、十几个字段，手抄一次就等于多一份会过期的副本。
 * 这里直接 import 真实的兵种数据，改完数值重跑 `npm run fantasy` 即可。
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import { abilityById, allAbilities } from '../src/core/ability-registry.ts';
import { CONFIG, ERAS } from '../src/core/config.ts';
import { FANTASY } from '../src/core/fantasy-packs.ts';
import { BURN_MAX_LAYERS, BURN_PER_LAYER } from '../src/core/rules.ts';
import { ELEMENT_NAME } from '../src/core/types.ts';

const OUT = new URL('../_build/fantasy-units.json', import.meta.url);

const names = new Map<string, string>();
for (const u of FANTASY.units ?? []) names.set(u.id, u.name);

// 合并成一个包之后，导出表里只有一节；id/name 仍写出来，表格按它分页
const packs = [FANTASY].map((p) => ({
  id: p.id,
  name: p.name,
  requires: p.requires ?? [],
  summary: p.summary,
  units: (p.units ?? []).map((u) => ({
    ...u,
    // 召唤表里存的是 id，表格里要的是名字
    summonText: u.summon
      ? u.summon.type
        ? `${names.get(u.summon.type) ?? u.summon.type}`
        : `随机（${(u.summon.random ?? []).map((id) => names.get(id) ?? id).join(' / ')}）`
      : '',
    splitText: u.splitInto ? (names.get(u.splitInto) ?? u.splitInto) : '',
    /**
     * 下面三个和 summonText 同理：存货里存的是 id，表里要的是名字。
     *
     * 补它们是因为 2026-11-02 审表时发现「机制总表」缺了口子：
     * 14 个会飞的兵一个字都没写飞行，土元素能盖土墙、魔龙卵两回合孵化、
     * 大史莱姆由小史莱姆合体——这些在表格里全看不见。
     */
    buildsText: (u.builds ?? []).map((id) => names.get(id) ?? id).join(' / '),
    hatchText: u.hatch ? `${names.get(u.hatch.into) ?? u.hatch.into}（${u.hatch.turns} 回合）` : '',
    mergeText: u.mergeInto ? (names.get(u.mergeInto) ?? u.mergeInto) : '',
    abilityNames: (u.abilities ?? []).map((id) => abilityById(id)?.name ?? id),
    abilitySummary: (u.abilities ?? []).map((id) => abilityById(id)?.summary ?? ''),
    // 技能表也倒出来：表格里要能给"每回合能开什么"单独一列
    skillText: (u.skills ?? [])
      .map((k) => `${k.name}（冷却 ${k.cooldown}）：${k.summary}`)
      .join('\n'),
  })),
}));

const payload = {
  generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
  elements: ELEMENT_NAME,
  eras: ERAS.map((e) => ({ level: e.level, name: e.name })),
  config: {
    splashRatio: CONFIG.splashRatio,
    counterAttackRatio: CONFIG.counterAttackRatio,
    maxUnits: CONFIG.maxUnits,
    terrainDef: CONFIG.terrainDef,
    burnPerLayer: BURN_PER_LAYER,
    burnMaxLayers: BURN_MAX_LAYERS,
  },
  abilities: allAbilities().map((a) => ({ id: a.id, name: a.name, group: a.group, summary: a.summary })),
  packs,
};

mkdirSync(new URL('../_build/', import.meta.url), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');

const total = packs.reduce((n, p) => n + p.units.length, 0);
console.log(`已导出 ${packs.length} 个包 / ${total} 个兵种 → _build/fantasy-units.json`);
