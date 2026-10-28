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
--    客户端会按"种子+回合+胜负+兵力"去重（记在本机），换设备 / 清缓存会漏。
--    一条 seed 出现多次且 turns/winner 完全一样，多半是同一个人传了两遍。
select seed, turns, winner, count(*) as copies, min(created_at) as first_at
from warchess_reports
group by seed, turns, winner
having count(*) > 1
order by copies desc, first_at desc
limit 50;


-- ⑨ 清理：只留最近 180 天（按需跑，跑之前先确认①里的量）
-- delete from warchess_reports where created_at < now() - interval '180 days';
