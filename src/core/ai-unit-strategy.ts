import type { Action, GameState, Unit, UnitTypeDef } from './types.ts';
import type { AiBudget } from './ai-meta.ts';
import type { TacticalMap } from './ai-tactics.ts';
import { CONFIG } from './config.ts';
import { canUseType, eraWindowOk } from './draft.ts';
import {
  armySize, attackableTargets, distance, heroBlocked,
  heroSkillsOf, previewAttack, reachableTiles, recruitPriceOf, recruitSpawnCells,
  underConstruction, upgradeCostOf,
} from './rules.ts';

type Candidate = { action: Action; score: number };
export interface FocusPurchasePlan { action: Action | null; reserveGold: number; reason: string }
const key = (a: Action): string => JSON.stringify(a);
const friends = (s: GameState): Unit[] => s.units.filter(u => u.owner === s.current && s.unitTypes[u.type]?.category === 'combat' && !underConstruction(u));
const escort = (s: GameState,u: Unit): boolean => {
  const d=s.unitTypes[u.type]!;
  return d.domain!=='water'&&!d.flight&&d.layer!=='air'&&(d.range??1)<=2&&u.type!=='mage'&&u.type!=='holy-knight-lord';
};

/** Only feed the player's fog view to these helpers. Explicit commander orders bypass this filter. */
export function specialistRecruitAllowed(s: GameState,d: UnitTypeDef,urgent: boolean): boolean {
  const own=friends(s);
  if(d.id==='mage'){
    const guards=own.filter(u=>escort(s,u)).length;
    const mages=own.filter(u=>u.type==='mage').length;
    if(!guards&&!urgent)return false;
    if(mages>=Math.max(1,Math.ceil(own.filter(u=>u.type!=='mage').length/2)))return false;
  }
  if(d.id==='holy-knight-lord'&&own.filter(u=>u.type!==d.id).length<2)return false;
  return true;
}

/** A legal, reusable focus order: buy a mixed group without freezing its initial defense. */
export function focusedPurchasePlan(s: GameState,budget: AiBudget): FocusPurchasePlan | null {
  const focus=budget.recruitFocus;
  if(!focus||focus.purchased>=focus.quota)return null;
  const def=s.unitTypes[focus.unitType];
  if(!def)return null;
  const gold=s.players[s.current].gold,price=recruitPriceOf(s,s.current,def).gold;
  const cities=s.cities.filter(c=>c.owner===s.current&&!c.ruined&&c.capturedTurn!==s.turn).sort((a,b)=>a.id.localeCompare(b.id));
  const available=(d: UnitTypeDef)=>cities.find(c=>eraWindowOk(s,d,c.era)&&canUseType(s,s.current,d.id)&&recruitSpawnCells(s,c.id,undefined,d.id).length>0);
  const targetCity=available(def);
  if(!targetCity||heroBlocked(s,s.current,def)||armySize(s,s.current)>=CONFIG.maxUnits)return null;
  const own=friends(s),foes=s.units.filter(u=>u.owner!==s.current&&s.unitTypes[u.type]?.category==='combat');
  const mayRecruit=budget.recruited<budget.maxRecruit;
  if(focus.unitType==='mage'&&focus.purchased===0&&cities.every(c=>c.era<4)&&budget.upgraded<budget.maxUpgrade){
    const city=cities.find(c=>c.era===3&&gold>=(upgradeCostOf(s,c)??Infinity)+price);
    if(city&&!foes.some(u=>distance(u,city)<=5))return {action:{type:'UPGRADE',cityId:city.id},reserveGold:price,reason:'preserve-one-mage-and-era'};
  }
  const liveGuards=own.filter(u=>escort(s,u)).length;
  const liveRanged=own.filter(u=>u.type!==focus.unitType&&(s.unitTypes[u.type]?.range??1)>=3).length;
  const supports=Math.max(focus.supportPurchased,own.filter(u=>u.type!==focus.unitType).length);
  const needRanged=focus.unitType==='holy-knight-lord'&&Math.max(focus.rangedSupportPurchased,liveRanged)<1;
  const needGuard=focus.unitType==='mage'&&Math.max(liveGuards,focus.supportPurchased)<Math.min(2,1+Math.floor(focus.purchased/2));
  const needSupport=focus.unitType==='holy-knight-lord'&&supports<2;
  if(mayRecruit&&(needRanged||needGuard||needSupport)){
    const choices=needRanged?['musketeer','archer','crossbow']:['ge','militia','spearman'];
    for(const type of choices){
      const d=s.unitTypes[type];if(!d||d.summonedOnly)continue;
      const city=available(d),cost=recruitPriceOf(s,s.current,d).gold;
      if(city&&gold>=cost)return {action:{type:'RECRUIT',cityId:city.id,unitType:type},reserveGold:0,reason:needRanged?'ranged-escort':'frontline-escort'};
    }
  }
  if(mayRecruit&&gold>=price&&(focus.unitType!=='mage'||focus.purchasedThisTurn<1))return {action:{type:'RECRUIT',cityId:targetCity.id,unitType:def.id},reserveGold:0,reason:'staged-focus-recruit'};
  return {action:null,reserveGold:price,reason:focus.unitType==='mage'&&focus.purchasedThisTurn>=1?'one-mage-per-turn':'save-with-escorts'};
}

export function specialistMoveBias(s: GameState,u: Unit,x: number,y: number,tactical: TacticalMap): number {
  if(u.type!=='mage'&&u.type!=='holy-knight-lord')return 0;
  const moved={...u,x,y},risk=tactical.exposure(moved),own=friends(s);
  if(u.type==='mage'){
    const hp=Math.max(1,u.hp),guards=own.filter(v=>v.id!==u.id&&escort(s,v)&&distance(v,moved)<=2).length;
    const firing=attackableTargets(s,moved).map(t=>previewAttack(s,moved,t)).reduce((best,p)=>Math.max(best,p.toDefender+p.toSplash-p.toAttacker),0);
    return Math.min(12,guards*5)+Math.min(12,Math.max(0,firing)*0.35)-Math.min(70,risk.damage/hp*24)-(risk.lethal?65:0);
  }
  const company=own.filter(v=>v.id!==u.id&&distance(v,moved)<=2);
  return Math.min(30,company.reduce((n,v)=>n+2+Math.min(5,(s.unitTypes[v.type]?.cost??0)/60),0))-(risk.lethal?60:0);
}

/** Select where to apply the buff before using its cooldown; the skill itself stays free. */
export function holyBannerCandidate(s: GameState,u: Unit,tactical: TacticalMap,rejected: ReadonlySet<string>): Candidate | null {
  if(u.type!=='holy-knight-lord'||u.skillTurn===s.turn)return null;
  const skill=heroSkillsOf(s,u).find(k=>k.def.id==='holy-banner');
  if(!skill?.ready)return null;
  const foes=s.units.filter(v=>v.owner!==u.owner&&s.unitTypes[v.type]?.category==='combat');
  if(!foes.some(v=>distance(v,u)<=6))return null;
  const radius=skill.def.radius??2,own=friends(s);
  const value=(at: Unit): number=>own.filter(v=>v.id!==u.id&&distance(v,at)<=radius&&!v.buff).reduce((n,v)=>{
    const risk=tactical.exposure(v).damage;
    return n+(1+Math.min(2,(s.unitTypes[v.type]?.cost??0)/150))*(0.5+Math.min(1.5,risk/Math.max(1,v.hp)));
  },0);
  const currentRisk=tactical.exposure(u),here=value(u)-currentRisk.damage*0.035;
  let best: {x:number;y:number;score:number}|null=null;
  if(!u.moved)for(const i of reachableTiles(s,u).keys()){
    const x=i%s.w,y=Math.floor(i/s.w);if(x===u.x&&y===u.y)continue;
    const action: Action={type:'MOVE',unitId:u.id,x,y};if(rejected.has(key(action)))continue;
    const moved={...u,x,y},risk=tactical.exposure(moved);
    if(risk.lethal||risk.damage>u.hp*0.65)continue;
    const score=value(moved)-risk.damage*0.035;
    if(score>here+1.0&&(!best||score>best.score))best={x,y,score};
  }
  if(best)return {action:{type:'MOVE',unitId:u.id,x:best.x,y:best.y},score:36+Math.min(12,best.score)};
  const cast: Action={type:'HERO_SKILL',unitId:u.id,skillId:'holy-banner'};
  if(rejected.has(key(cast)))return null;
  if(value(u)<1&&currentRisk.damage===0)return null;
  return {action:cast,score:28+Math.min(12,value(u))};
}
