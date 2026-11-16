-- 关卡审核：把"玩家分享"里的关卡放行 / 退回。
--
-- 和 warchess_maps_review.sql 是同一套三步流程，理由也一样：
--   审核靠的是**权限**而不是界面——
--     · 读策略 `using (listed)`：没放行，连作者自己都查不到；
--     · 插入策略要求 `listed = false`：客户端插不出"已公开"的行；
--     · **没有 update 策略**：客户端连改这个开关的权限都不存在。
--   在游戏里加"审核"按钮等于先给自己开一条 update 权限，审核就白做了。
--
-- 关卡比地图多一层风险：它带**事件**（刷兵、改地形、换 AI 打法）。
-- 所以审的时候要顺便看一眼事件，别只看名字和尺寸：
--   · 事件能不能把地图切成两块、能不能把玩家的城淹了；
--   · 刷兵是不是直接刷在出生点旁边（那是"耍赖"而不是"援军"）；
--   · `expansions.require` 里有没有要求一个很冷门的包（玩家开不了这一关就废了）。

-- ① 队列：还没放行的，最新的在前
select id, created_at, name, author, w, h, seats, events
from public.warchess_levels
where not listed
order by created_at desc
limit 50;

-- ①b 看这一关到底写了什么（把 $1 换成上一条里的 id）
--     data 就是整份 LevelDef，事件、胜负、AI 参数都在里面
select id, name, author, w, h, data
from public.warchess_levels
where id = $1;

-- ② 放行：放行之后立刻出现在所有玩家的「别人的关卡」里
update public.warchess_levels set listed = true where id = $1;

-- ③ 退回：直接删掉。作者那边靠本机文件仍然能玩到，删掉只是让队列短一点
delete from public.warchess_levels where id = $1 and not listed;

-- 附带：放行错了（撤回来）——所有人的列表里立刻少掉这一关
update public.warchess_levels set listed = false where id = $1;

-- 顺手看看库的规模
select count(*) as total,
       count(*) filter (where listed) as listed,
       count(*) filter (where not listed) as pending
from public.warchess_levels;
