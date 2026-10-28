-- 对局数据的分析查询集
--
-- 用法：在云服务面板的数据库查询窗口里执行（要管理员身份——anon 只能写不能读）。
-- 每条都是独立一句，挑着跑，不要一次全贴。
--
-- 前置：先跑过 sql/warchess_reports.sql（表 + 两个视图）。
--   warchess_reports_by_side  —— 一场两行，带 won / ai_level / 阵容
--   warchess_reports_units    —— 一个兵种一行，用来算采用率
--
-- 样本量提醒：每张表都自带 n，n < 30 之前别急着下结论。
-- 这是从"跑批模拟"换成"真人真局"的代价——数据真了，但来得慢。


-- ① 总览：收了多少局、覆盖多少天、平均多少回合
select count(*)                                as games,
       count(distinct date_trunc('day', created_at)) as days,
       round(avg(turns)::numeric, 1)           as avg_turns,
       count(*) filter (where winner is null)  as draws,
       min(created_at)                         as first_at,
       max(created_at)                         as last_at
from warchess_reports;


-- ② 先手胜率（A 座）：玩家最在意的那一条
--    只算分出胜负的局，平局单独看①里的 draws
select count(*)                                              as decided,
       count(*) filter (where winner = 'A')                  as a_wins,
       round(100.0 * count(*) filter (where winner = 'A') / count(*), 1) as a_win_pct
from warchess_reports
where winner is not null;


-- ③ 按 AI 难度分组的胜负：这就是"战术档到底行不行"的真人版答案
--    注意 sides 里 AI 在哪一边不固定，所以这里看的是"某档位参与的局里，A/B 各赢多少"，
--    要判断某档强不强，请配合 ai_opponent / ai_ally 看是单 AI 还是双 AI。
select ai_level,
       count(distinct id)                                     as games,
       count(distinct id) filter (where winner is null)        as draws,
       round(avg(turns)::numeric, 1)                          as avg_turns,
       round(100.0 * count(*) filter (where won) / nullif(count(*) filter (where won is not null), 0), 1) as side_win_pct
from warchess_reports_by_side
group by ai_level
order by games desc;


-- ④ 哪套扩展一开就一边倒
--    side_win_pct 接近 50 说明两方均衡；偏离 50 越多越是"这套扩展偏袒一方"。
--    平局率高的扩展值得单独看——那可能不是均衡，是双方都推不动。
select array_to_string(expansions, '+')                        as pack,
       count(distinct id)                                      as games,
       round(100.0 * count(distinct id) filter (where winner is null) / count(distinct id), 1) as draw_pct,
       round(avg(turns)::numeric, 1)                            as avg_turns
from warchess_reports
group by expansions
having count(*) >= 10
order by games desc;


-- ⑤ 兵种采用率：终局阵容里出现过它的局占多少
--    这是"这个兵种到底有没有人用"的直接答案（比模拟里的更强，因为是人选的）
select unit_id,
       count(distinct id)                                        as games,
       sum(count)                                                as total_alive,
       round(avg(count)::numeric, 2)                             as avg_alive_per_game
from warchess_reports_units
group by unit_id
having count(distinct id) >= 10
order by games desc, total_alive desc;


-- ⑥ 兵种和胜负的相关性（粗略版）
--    别当因果读：贵的兵出现在赢的一方，很可能是因为赢了才有钱。
--    它只回答"哪些兵经常出现在赢的一边"，剩下的靠人判断。
select u.unit_id,
       count(*) filter (where s.won)                             as in_wins,
       count(*) filter (where s.won is false)                     as in_losses,
       round(100.0 * count(*) filter (where s.won)
             / nullif(count(*) filter (where s.won is not null), 0), 1) as win_pct_when_present
from warchess_reports_units u
join warchess_reports_by_side s on s.id = u.id and s.side = u.side
group by u.unit_id
having count(*) >= 20
order by win_pct_when_present desc nulls last;


-- ⑦ 终局经济画像：赢的一方还剩多少钱、还剩多少兵
--    "赢家金库还剩三位数"= 钱花不出去，是产线/编制卡住了的信号。
select s.won,
       count(*)                                                   as rows,
       round(avg(s.gold)::numeric, 1)                             as avg_gold,
       round(avg(s.units)::numeric, 1)                            as avg_units,
       round(avg(s.cities)::numeric, 2)                           as avg_cities,
       round(avg(s.hp)::numeric, 0)                               as avg_hp
from warchess_reports_by_side s
group by s.won
order by s.won nulls last;


-- ⑧ 重复上传排查
--    现在已经有两层去重：客户端指纹（记在本机）+ 服务端 fingerprint 唯一索引
--    （跨设备）。理论上不该有重复了；这条用来验证"真的没有"，
--    以及看历史上（加索引之前）有没有积压。
select fingerprint, count(*) as copies, min(created_at) as first_at
from warchess_reports
where fingerprint is not null
group by fingerprint
having count(*) > 1
order by copies desc
limit 50;

-- ⑧b 按 seed 看（老数据没有 fingerprint，只能用这几个字段凑）
select seed, turns, winner, count(*) as copies, min(created_at) as first_at
from warchess_reports
group by seed, turns, winner
having count(*) > 1
order by copies desc, first_at desc
limit 50;


-- ⑩ 来源分布：每个浏览器代号交了多少
--    用来区分"几十个玩家各交一局"和"一个人交了几十局"。
--    同一小时超过 30 条的会被触发器拒掉，所以这里不会有更大的数。
select client_id,
       count(*)                                   as reports,
       count(distinct date_trunc('day', created_at)) as days,
       min(created_at)                             as first_at,
       max(created_at)                             as last_at
from warchess_reports
group by client_id
order by reports desc
limit 30;


-- ⑪ 带逐回合摘要的局有多少（决定"曲线"那部分样本够不够）
select payload->'timeline' is not null                as has_timeline,
       count(*)                                        as games,
       round(avg(jsonb_array_length(coalesce(payload->'timeline'->'samples','[]'::jsonb)))::numeric, 1) as avg_frames
from warchess_reports
group by 1;


-- ⑨ 清理：只留最近 180 天（按需跑，跑之前先确认①里的量）
-- delete from warchess_reports where created_at < now() - interval '180 days';


-- ⑫ 按批次看：哪一批数据是谁带来的、干不干净
--    某一批局的"未决率/平均回合"明显偏离其他批次时，先怀疑那一批的采集方式，
--    而不是怀疑游戏平衡。verdict='quarantined' 的批次不要进结论。
select coalesce(campaign, '(直接来的)') as campaign,
       count(*)                          as games,
       count(*) filter (where verdict = 'plausible')     as plausible,
       count(*) filter (where verdict = 'quarantined')   as quarantined,
       round(avg(turns)::numeric, 1)     as avg_turns,
       min(created_at)                   as first_at,
       max(created_at)                   as last_at
from warchess_reports
group by 1
order by games desc;


-- ⑬ 同意版本分布：改过告知文案之后，能看出新老数据各占多少
select coalesce(consent, '(未记录)') as consent_version, count(*) as games
from warchess_reports
group by 1
order by games desc;


-- ⑭ 隔离一批可疑数据（先看⑫，再决定 in 哪些 id）
-- update warchess_reports set verdict = 'quarantined'
--  where campaign = 'xxx' and created_at between '2026-10-28' and '2026-10-29';
