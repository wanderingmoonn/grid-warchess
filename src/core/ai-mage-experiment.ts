import type { Action, GameState, Unit } from './types.ts';
import type { AiBudget } from './ai-meta.ts';
import type { TacticalMap } from './ai-tactics.ts';
import { CONFIG } from './config.ts';
import { canUseType, eraWindowOk } from './draft.ts';
import { armySize, attackableTargets, distance, previewAttack, recruitPriceOf, recruitSpawnCells, underConstruction, upgradeCostOf } from './rules.ts';

/** Optional experiment context; never persisted in the match or enabled by the normal AI. */
export type MageExperimentBudget = AiBudget & {
  mageBatch?: { purchased: number; quota: number; purchasedThisTurn: number; armyCap: number };
};

/** The upgrade component from the sealed combined strategy, without its purchase cap or movement bias. */
export function mageOpeningUpgrade(s: GameState, budget: AiBudget, purchased: number): Action | null {
  const mage=s.unitTypes.mage;
  if(!mage||purchased!==0||budget.upgraded>=budget.maxUpgrade)return null;
  const cities=s.cities.filter(c=>c.owner===s.current&&!c.ruined&&c.capturedTurn!==s.turn).sort((a,b)=>a.id.localeCompare(b.id));
  if(!cities.length||cities.some(c=>c.era>=4))return null;
  if(armySize(s,s.current)>=CONFIG.maxUnits||!cities.some(c=>eraWindowOk(s,mage,c.era)&&canUseType(s,s.current,'mage')&&recruitSpawnCells(s,c.id,undefined,'mage').length>0))return null;
  const price=recruitPriceOf(s,s.current,mage).gold;
  const city=cities.find(c=>c.era===3&&s.players[s.current].gold>=(upgradeCostOf(s,c)??Infinity)+price);
  if(!city||s.units.some(u=>u.owner!==s.current&&s.unitTypes[u.type]?.category==='combat'&&distance(u,city)<=5))return null;
  return {type:'UPGRADE',cityId:city.id};
}

/** A batch means at most one of the first four mages each own turn, reserving the next mage's price. */
export function mageBatchActionAllowed(s: GameState, budget: MageExperimentBudget, action: Action): boolean {
  const batch=budget.mageBatch,mage=s.unitTypes.mage;
  if(!batch||!mage||batch.purchased>=batch.quota||armySize(s,s.current)>=batch.armyCap)return true;
  const site=s.cities.some(c=>c.owner===s.current&&!c.ruined&&c.era>=mage.era&&recruitSpawnCells(s,c.id,undefined,'mage').length>0);
  if(!site)return true;
  if(action.type==='RECRUIT'&&action.unitType==='mage'&&batch.purchasedThisTurn>=1)return false;
  const cost=action.type==='RECRUIT'||action.type==='BUILD'
    ? recruitPriceOf(s,s.current,s.unitTypes[action.unitType]!).gold
    : action.type==='UPGRADE' ? upgradeCostOf(s,s.cities.find(c=>c.id===action.cityId)!)??Infinity : 0;
  return cost<=0||s.players[s.current].gold-cost>=recruitPriceOf(s,s.current,mage).gold;
}

/** Formula parity with the mage branch of the preceding sealed positioning strategy. */
export function magePositionBias(s: GameState,u: Unit,x: number,y: number,tactical: TacticalMap): number {
  if(u.type!=='mage')return 0;
  const moved={...u,x,y},risk=tactical.exposure(moved);
  const own=s.units.filter(v=>v.owner===s.current&&s.unitTypes[v.type]?.category==='combat'&&!underConstruction(v));
  const guards=own.filter(v=>{
    const d=s.unitTypes[v.type]!;
    return v.id!==u.id&&d.domain!=='water'&&!d.flight&&d.layer!=='air'&&(d.range??1)<=2&&v.type!=='mage'&&v.type!=='holy-knight-lord'&&distance(v,moved)<=2;
  }).length;
  const firing=attackableTargets(s,moved).map(t=>previewAttack(s,moved,t)).reduce((best,p)=>Math.max(best,p.toDefender+p.toSplash-p.toAttacker),0);
  return Math.min(12,guards*5)+Math.min(12,Math.max(0,firing)*0.35)-Math.min(70,risk.damage/Math.max(1,u.hp)*24)-(risk.lethal?65:0);
}
