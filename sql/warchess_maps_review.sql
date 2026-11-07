-- 地图审核：把"玩家上传"里的图放行 / 退回。
--
-- 为什么只能在这里做（而不是游戏里给个开关）：
--   这张表是公开可写的，客户端拿的 publishableKey 不带任何权限。审核靠的是
--   **权限**而不是界面——
--     · 读策略 `using (listed)`：没放行的行，连作者自己都查不到；
--     · 插入策略要求 `listed = false`：客户端插不出"已公开"的行；
--     · **没有 update 策略**：客户端连改这个开关的权限都不存在。
--   所以在游戏里加一个"审核"按钮，等于先给自己开一条 update 权限，
--   那审核就白做了。放行只能用管理员身份（云数据库控制台 / 这个 MCP 工具）。
--
-- 三步日常：
--   ① 看队列 → ② 决定 → ③ 放行或删掉。
-- 每条都要单独执行（控制台一次只能跑一条）。

-- ① 队列：还没放行的，最新的在前。rows 是地形数据，看着长，先不取。
select id, created_at, name, author, w, h
from public.warchess_maps
where not listed
order by created_at desc
limit 50;

-- ①b 想看图本身再决定（把 $1 换成上一条里的 id）
select id, name, author, w, h, rows, cities_a, cities_b
from public.warchess_maps
where id = $1;

-- ② 放行：放行之后立刻出现在所有玩家的「玩家上传地图」里（读策略只查 listed=true）
update public.warchess_maps set listed = true where id = $1;

-- ③ 退回：直接删掉。留着没有意义——客户端读不到未放行的行，
--    作者那边靠本机缓存仍然能玩到，删掉只是让队列短一点。
delete from public.warchess_maps where id = $1 and not listed;

-- 附带：放行错了（撤回来）——这一步会让所有人的列表里立刻少掉这张图
update public.warchess_maps set listed = false where id = $1;

-- 顺手看看库的规模
select count(*) as total,
       count(*) filter (where listed) as listed,
       count(*) filter (where not listed) as pending
from public.warchess_maps;
