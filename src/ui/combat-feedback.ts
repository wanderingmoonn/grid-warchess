import type { PlayerView } from '../core/fog.ts';
import type { Action, GameState, PlayerId, Unit } from '../core/types.ts';
import { cityName, simulateCombat, utype } from '../core/rules.ts';

export type CombatAction = Extract<Action, { type: 'ATTACK' | 'SIEGE' }>;

export interface CombatHealth {
  name: string;
  before: number;
  after: number;
  removed: boolean;
  extraBefore?: number;
  extraAfter?: number;
}

export interface CombatForecast {
  action: CombatAction;
  attacker: CombatHealth;
  target: CombatHealth;
  collateral: number;
  city: boolean;
}

function health(s: GameState, before: Unit, after?: Unit): CombatHealth {
  return {
    name: utype(s, before.type).name,
    before: before.hp,
    after: Math.max(0, after?.hp ?? 0),
    removed: !after,
    extraBefore: before.extraHp ?? 0,
    extraAfter: after?.extraHp ?? 0,
  };
}

export function forecastCombat(view: PlayerView, me: PlayerId, action: CombatAction): CombatForecast | null {
  const s = view.state;
  const attacker = s.units.find((unit) => unit.id === action.unitId);
  if (!attacker || attacker.owner !== me || s.current !== me) return null;
  const target = action.type === 'ATTACK' ? s.units.find((unit) => unit.id === action.targetId) : undefined;
  const city = action.type === 'SIEGE' ? s.cities.find((entry) => entry.id === action.cityId) : undefined;
  if (!target && !city) return null;
  const result = simulateCombat(s, action);
  if (!result.ok) return null;
  const after = result.state;
  const targetAfter = target ? after.units.find((unit) => unit.id === target.id) : undefined;
  const cityAfter = city ? after.cities.find((entry) => entry.id === city.id) : undefined;
  return {
    action,
    attacker: health(s, attacker, after.units.find((unit) => unit.id === attacker.id)),
    target: target ? health(s, target, targetAfter) : {
      name: cityName(city!), before: city!.hp,
      after: Math.max(0, cityAfter?.hp ?? 0), removed: !cityAfter || cityAfter.ruined === true,
    },
    collateral: s.units.filter((unit) => unit.id !== attacker.id && unit.id !== target?.id &&
      (after.units.find((entry) => entry.id === unit.id)?.hp ?? 0) < unit.hp).length,
    city: !!city,
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function healthHtml(label: string, item: CombatHealth, city = false): string {
  const delta = item.after - item.before;
  return `<div class="combat-health"><span>${label} · ${escapeHtml(item.name)}</span>
    <div><b>${item.before} → ${item.after}</b><strong class="${delta < 0 ? 'loss' : delta > 0 ? 'gain' : 'neutral'}">${delta > 0 ? '+' : ''}${delta}</strong></div>
    ${(item.extraBefore ?? 0) > 0 || (item.extraAfter ?? 0) > 0 ? `<small>额外生命 ${item.extraBefore ?? 0} → ${item.extraAfter ?? 0}</small>` : ''}
    ${item.removed ? `<small>${city ? '城墙将被攻破，仍需派兵接管' : '该单位预计离场'}</small>` : ''}</div>`;
}

export function combatForecastHtml(forecast: CombatForecast, pinned: boolean): string {
  return `<div class="combat-preview-head"><b>${forecast.city ? '攻城预览' : '交锋预览'}</b>
    <button class="btn btn-sm" data-combat="cancel" aria-label="关闭攻击预览">关闭</button></div>
    ${healthHtml(forecast.city ? '目标耐久' : '目标生命', forecast.target, forecast.city)}
    ${healthHtml('本方生命', forecast.attacker)}
    <p class="combat-preview-note">${forecast.collateral > 0 ? `另有 ${forecast.collateral} 个可见单位受到波及。` : ''}已计入反击及可见效果；伏兵和未公开事件可能改变结果。</p>
    <button class="btn btn-primary btn-block" data-combat="confirm">${pinned ? '确认' : '执行'}${forecast.city ? '攻城' : '攻击'}</button>`;
}

export function actionFeedback(before: PlayerView, after: PlayerView, action: Action): string | null {
  const unit = 'unitId' in action ? before.state.units.find((entry) => entry.id === action.unitId) : undefined;
  const name = unit ? utype(before.state, unit.type).name : '单位';
  if (action.type === 'MOVE') return `${name} 已移动到 ${String.fromCharCode(65 + action.x)}${action.y + 1}`;
  if (action.type === 'ATTACK' || action.type === 'SIEGE') {
    const target = action.type === 'ATTACK'
      ? before.state.units.find((entry) => entry.id === action.targetId)
      : before.state.cities.find((entry) => entry.id === action.cityId);
    if (!target) return '攻击已结算';
    const remaining = action.type === 'ATTACK'
      ? after.state.units.find((entry) => entry.id === action.targetId)
      : after.state.cities.find((entry) => entry.id === action.cityId);
    const targetName = 'type' in target ? utype(before.state, target.type).name : cityName(target);
    const current = remaining ? Math.max(0, remaining.hp) : '当前不可见';
    const self = unit ? after.state.units.find((entry) => entry.id === unit.id) : undefined;
    const selfLoss = unit ? Math.max(0, unit.hp - (self?.hp ?? 0)) : 0;
    const extraBefore = 'type' in target ? target.extraHp ?? 0 : 0;
    const extraAfter = remaining && 'type' in remaining ? remaining.extraHp ?? 0 : extraBefore;
    return `${name} → ${targetName}：${target.hp} → ${current}${extraBefore !== extraAfter ? `；额外生命 ${extraBefore} → ${extraAfter}` : ''}${selfLoss > 0 ? `；本方损失 ${selfLoss} 生命` : ''}${!remaining ? '；目标已离开当前视图' : 'ruined' in remaining && remaining.ruined ? '；城墙已破，派兵接管' : ''}`;
  }
  if (action.type === 'RECRUIT') return `${before.state.unitTypes[action.unitType]?.name ?? '新兵'} 已生产，本回合不能行动`;
  if (action.type === 'BUILD') return `${before.state.unitTypes[action.unitType]?.name ?? '建筑'} 已下达建造指令`;
  if (action.type === 'UPGRADE') return '城市时代已升级，可在生产列表查看新兵种';
  return null;
}
