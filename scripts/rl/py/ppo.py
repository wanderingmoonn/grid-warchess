"""PPO 的核心：读采样文件、算 GAE、更新 scorer 与价值头。

── 这个实现为什么长这样 ────────────────────────────────────────────────

策略是**两段式**的：预筛（线性）挑 16 个候选，再让 MLP 在这 16 个里排序。
PPO 的 ratio 必须在**同一批候选**上算，所以采样时就把候选特征存了下来，
训练时只在它们上面做 softmax——不需要、也不该重新选候选。

预筛不训练（它不进 softmax，没有梯度，跟着变会让"当时那批候选"和"现在这批"不是同一批）。

── 一个自带的正确性检查 ────────────────────────────────────────────────

更新前先算一遍 `ratio = exp(logp_new - logp_old)`：如果 Python 的前向和 TS 的
前向真的一致，**batch 上的 ratio 必须全是 1.000**（我看到的是 max|ratio-1| < 1e-6）。
这条比什么单测都直接：它验的是"训练用的分布"就是"采样用的分布"。
"""

from __future__ import annotations

import json
from dataclasses import dataclass

import numpy as np
import torch
import torch.nn as nn

import net


@dataclass
class Rollout:
    """一份采样文件展开成的大数组（都是 numpy，按时间顺序）。"""

    state: np.ndarray  # [n, S]
    cand: np.ndarray  # [n, K, A]
    idx: np.ndarray  # [n] 选中动作在候选里的位置
    logp: np.ndarray  # [n]
    value: np.ndarray  # [n]
    reward: np.ndarray  # [n]
    game: np.ndarray  # [n]
    turn: np.ndarray  # [n] 这一步是本回合第几手（用来分"开局/中局/残局"桶）
    kused: np.ndarray  # [n] 这一步真正有几个候选（不足 K 时尾巴是补零，必须屏蔽）
    seat: np.ndarray  # [n] 0=A 1=B（自博弈时一局里有两条流，GAE 必须分开算）
    manifest: dict

    def __len__(self) -> int:
        return int(self.state.shape[0])


def load_rollout(base: str, drop_timeouts: bool = True) -> Rollout:
    """读 `<base>.json` + `<base>.bin`。布局：每步 width 个 float32 平铺。

    `drop_timeouts`：把"撞上回合上限"的整局丢掉。
    这个游戏里 `winner === null` 只可能是没打完，而"平局 0 分"比"输 −1 分"好，
    于是那些步会被当成"干得不错"——策略因此学会了拖时间（实测中位数 22 → 40 回合）。
    与其给它一个惩罚的数值，不如整局不要：没打完的棋不构成"这一步好不好"的证据。
    """
    with open(f"{base}.json", "r", encoding="utf-8") as fh:
        man = json.load(fh)
    width = int(man["width"])
    flat = np.fromfile(f"{base}.bin", dtype="<f4")
    if flat.size % width != 0:
        raise ValueError(f"采样文件长度 {flat.size} 不是 {width} 的整数倍——多半是上次没写完")
    rows = flat.reshape(-1, width)

    s_dim, a_dim, k = int(man["state"]), int(man["action"]), int(man["k"])
    if drop_timeouts and "perGame" in man:
        dead = [g["seed"] for g in man["perGame"] if g.get("timedOut")]
        # perGame 的下标就是局号（rollout 里 game 字段写的是 g），按 seed 反查太绕，直接用位置
        dead_idx = {i for i, g in enumerate(man["perGame"]) if g.get("timedOut")}
        keep = ~np.isin(rows[:, s_dim + k * a_dim + 4].astype(np.int64), list(dead_idx))
        dropped = int((~keep).sum())
        man["droppedSteps"] = dropped
        man["droppedGames"] = len(dead_idx)
        rows = rows[keep]
        del dead

    state = rows[:, :s_dim].copy()
    cand = rows[:, s_dim : s_dim + k * a_dim].reshape(-1, k, a_dim).copy()
    tail = s_dim + k * a_dim
    logp = rows[:, tail + 0].copy()
    value = rows[:, tail + 1].copy()
    reward = rows[:, tail + 2].copy()
    idx = rows[:, tail + 3].astype(np.int64)
    game = rows[:, tail + 4].astype(np.int64)
    turn = rows[:, tail + 5].astype(np.int64)
    kused = rows[:, tail + 6].astype(np.int64)
    seat = rows[:, tail + 7].astype(np.int64) if rows.shape[1] > tail + 7 else np.zeros(len(rows), dtype=np.int64)
    return Rollout(state, cand, idx, logp, value, reward, game, turn, kused, seat, man)


def compute_gae(
    rollout: Rollout, gamma: float = 0.997, lam: float = 0.95
) -> tuple[np.ndarray, np.ndarray]:
    """按局算 GAE。

    必须**按局断开**：跨局累计等于把上一局的胜负当成下一局的前置状态，
    而两局之间没有任何因果关系（换种子、换地图、兵力从零开始）。
    局面里其实带着 `turn`（第几步），这里用 game 分组就够了。
    """
    adv = np.zeros(len(rollout), dtype=np.float32)
    ret = np.zeros(len(rollout), dtype=np.float32)
    # 一局自博弈里有两条独立的流（A 的角度和 B 的角度），必须分开算：
    # 把两边混成一条，等于让"我赢了"这个信号去解释"对手那几步为什么好"。
    streams = np.unique(rollout.game * 2 + rollout.seat)
    for key in streams:
        sel = np.where(rollout.game * 2 + rollout.seat == key)[0]
        last_gae = 0.0
        next_value = 0.0  # 一局结束之后没有"下一步"
        for t in range(len(sel) - 1, -1, -1):
            i = sel[t]
            delta = float(rollout.reward[i]) + gamma * next_value - float(rollout.value[i])
            last_gae = delta + gamma * lam * last_gae
            adv[i] = last_gae
            ret[i] = last_gae + float(rollout.value[i])
            next_value = float(rollout.value[i])
    return adv, ret


class TorchPolicy(nn.Module):
    """和 TS 的 scorer + value 一一对应。

    注意这里**没有预筛**：它冻结在权重文件里，训练既不读也不写。
    """

    def __init__(self, w: net.Weights):
        super().__init__()
        self.spec = w.spec
        self.s_w1 = nn.Parameter(torch.from_numpy(w.s_w1.copy()))
        self.s_b1 = nn.Parameter(torch.from_numpy(w.s_b1.copy()))
        self.s_w2 = nn.Parameter(torch.from_numpy(w.s_w2.copy()))
        self.s_b2 = nn.Parameter(torch.tensor(float(w.s_b2)))
        self.v_w1 = nn.Parameter(torch.from_numpy(w.v_w1.copy()))
        self.v_b1 = nn.Parameter(torch.from_numpy(w.v_b1.copy()))
        self.v_w2 = nn.Parameter(torch.from_numpy(w.v_w2.copy()))
        self.v_b2 = nn.Parameter(torch.tensor(float(w.v_b2)))

    def forward(
        self, state: torch.Tensor, cand: torch.Tensor, kused: torch.Tensor | None = None
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """state [B,S], cand [B,K,A] → (logits [B,K], value [B])

        `kused` 给了就把补零的那些候选屏蔽掉（-inf 不进 softmax）：
        采样时 softmax 只在那 kused 个候选上做，训练时必须一样。
        """
        b, k, _ = cand.shape
        joint = torch.cat([state.unsqueeze(1).expand(b, k, state.shape[1]), cand], dim=-1)
        h = torch.relu(joint @ self.s_w1.t() + self.s_b1)
        logits = h @ self.s_w2 + self.s_b2
        if kused is not None:
            mask = torch.arange(k).unsqueeze(0) >= kused.unsqueeze(1)
            logits = logits.masked_fill(mask, float("-inf"))
        hv = torch.relu(state @ self.v_w1.t() + self.v_b1)
        value = torch.tanh(hv @ self.v_w2 + self.v_b2)
        return logits, value

    def to_weights(self, template: net.Weights) -> net.Weights:
        """导出成 TS 能读的权重（预筛原样保留）。"""
        def arr(p: nn.Parameter) -> np.ndarray:
            return p.detach().numpy().astype(np.float32)

        return net.Weights(
            version=template.version,
            spec=template.spec,
            pre_w=template.pre_w.copy(),
            pre_b=template.pre_b,
            s_w1=arr(self.s_w1),
            s_b1=arr(self.s_b1),
            s_w2=arr(self.s_w2),
            s_b2=float(self.s_b2.detach()),
            v_w1=arr(self.v_w1),
            v_b1=arr(self.v_b1),
            v_w2=arr(self.v_w2),
            v_b2=float(self.v_b2.detach()),
        )


@dataclass
class PpoConfig:
    lr: float = 3e-4
    clip: float = 0.2
    epochs: int = 4
    batch: int = 2048
    gamma: float = 0.997
    lam: float = 0.95
    vf_coef: float = 0.5
    ent_coef: float = 0.01
    max_grad_norm: float = 0.5


def update(model: TorchPolicy, roll: Rollout, cfg: PpoConfig) -> dict[str, float]:
    """跑一轮 PPO。返回诊断量（第一轮的 ratio 偏差就是"两侧前向一致"的证明）。"""
    adv, ret = compute_gae(roll, cfg.gamma, cfg.lam)
    adv = (adv - adv.mean()) / (adv.std() + 1e-8)

    st = torch.from_numpy(roll.state)
    cd = torch.from_numpy(roll.cand)
    ix = torch.from_numpy(roll.idx)
    ku = torch.from_numpy(roll.kused)
    old_logp = torch.from_numpy(roll.logp)
    adv_t = torch.from_numpy(adv)
    ret_t = torch.from_numpy(ret)
    index = np.arange(len(roll))

    opt = torch.optim.Adam(model.parameters(), lr=cfg.lr)
    stats: dict[str, float] = {}
    n = len(roll)

    for epoch in range(cfg.epochs):
        np.random.shuffle(index)
        for start in range(0, n, cfg.batch):
            sel = index[start : start + cfg.batch]
            if len(sel) < 8:
                continue
            logits, value = model(st[sel], cd[sel], ku[sel])
            logp = torch.log_softmax(logits, dim=-1).gather(1, ix[sel].unsqueeze(1)).squeeze(1)
            ratio = torch.exp(logp - old_logp[sel])
            if epoch == 0 and start == 0:
                # 采样与训练两侧的前向是否一致：一致则全 1
                stats["ratio_dev_max"] = float((ratio - 1).abs().max().detach())
                # 同一行取两个数：一个来自本次前向、一个来自采样文件，方便肉眼对
                row = int(sel[0])
                stats["relogp"] = float(logp[0].detach())
                stats["sampled_logp"] = float(old_logp[row])
            a = adv_t[sel]
            unclipped = ratio * a
            clipped = torch.clamp(ratio, 1 - cfg.clip, 1 + cfg.clip) * a
            policy_loss = -torch.min(unclipped, clipped).mean()
            value_loss = torch.nn.functional.mse_loss(value, ret_t[sel])
            probs = torch.softmax(logits, dim=-1)
            entropy = -(probs * torch.log(probs + 1e-9)).sum(dim=-1).mean()
            loss = policy_loss + cfg.vf_coef * value_loss - cfg.ent_coef * entropy

            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), cfg.max_grad_norm)
            opt.step()

            stats["loss"] = float(loss.detach())
            stats["policy_loss"] = float(policy_loss.detach())
            stats["value_loss"] = float(value_loss.detach())
            stats["entropy"] = float(entropy.detach())
            stats["ratio_mean"] = float(ratio.mean().detach())
            stats["clip_frac"] = float(((ratio - 1).abs() > cfg.clip).float().mean().detach())

    # 近似 KL（旧策略 || 新策略），PPO 调参最常看的那个数
    with torch.no_grad():
        logits, _ = model(st, cd, ku)
        new_logp = torch.log_softmax(logits, dim=-1).gather(1, ix.unsqueeze(1)).squeeze(1)
        stats["approx_kl"] = float((old_logp - new_logp).mean())
    return stats


# ── 分桶诊断：训练到底"在哪里"在动 ────────────────────────────────────
#
# 只报一个总 loss 是看不出问题的：它可能被某一类局面长期主导，
# 其余局面几乎不更新，而曲线照样平滑下降。所以按两个维度拆开看：
#
#   · 回合位置：开局 / 中局 / 残局。如果只有开局在动，说明策略学的是"开局怎么摆"，
#     而真正决定胜负的中后期没在被优化；
#   · 动作类型：走子 / 攻击 / 攻城 / 造兵 / 升级 / 结束回合。如果"结束回合"占了绝大多数
#     更新量，说明它在学"赶紧跳过这一回合"，那是典型的奖励稀疏病。
#
# 每个桶报三件事：样本占比、平均优势（信号强弱）、平均 Δlogp（这一桶被推动了多少）。
# 「优势大而 Δlogp 小」的那一桶，就是被别处梯度挤掉的地方。

# 和 features.ts 的 ACTION_KINDS_NAMES 一一对应（v2 从 7 格扩到 13 格）
TYPE_NAMES = [
    "走子", "攻击", "攻城", "造城兵", "造营兵", "升级", "结束回合",
    "盖建筑", "上船", "下船", "英雄技能", "遣散", "放蛋",
]

TURN_BUCKETS = [(0, 9, "开局 1-10"), (10, 29, "前中 11-30"), (30, 59, "中局 31-60"), (60, 10**9, "残局 60+")]


def _action_types(roll: Rollout) -> np.ndarray:
    """从候选特征的前 13 维（动作类型 one-hot）反推这一步选的是什么动作。"""
    chosen = roll.cand[np.arange(len(roll)), np.clip(roll.idx, 0, roll.cand.shape[1] - 1)]
    return np.argmax(chosen[:, : len(TYPE_NAMES)], axis=1)


def diagnose(model: TorchPolicy, roll: Rollout, adv: np.ndarray, old_logp: np.ndarray) -> list[tuple[str, np.ndarray, np.ndarray, np.ndarray]]:
    """算每个桶的 (样本数, 平均优势, 平均 Δlogp, 平均熵)。"""
    with torch.no_grad():
        logits, value = model(
            torch.from_numpy(roll.state), torch.from_numpy(roll.cand), torch.from_numpy(roll.kused)
        )
        new_logp = torch.log_softmax(logits, dim=-1).gather(
            1, torch.from_numpy(roll.idx).unsqueeze(1)
        ).squeeze(1).numpy()
        probs = torch.softmax(logits, dim=-1)
        ent = -(probs * torch.log(probs + 1e-9)).sum(dim=-1).numpy()

    delta = new_logp - old_logp
    types = _action_types(roll)
    groups: list[tuple[str, np.ndarray]] = []
    for lo, hi, name in TURN_BUCKETS:
        groups.append((f"回合 {name}", (roll.turn >= lo) & (roll.turn <= hi)))
    for i, name in enumerate(TYPE_NAMES):
        groups.append((f"动作 {name}", types == i))
    groups.append(("席位 A", roll.seat == 0))
    groups.append(("席位 B", roll.seat == 1))

    out = []
    for name, mask in groups:
        n = int(mask.sum())
        if n == 0:
            continue
        out.append((name, np.array([n]), adv[mask].mean(keepdims=True), delta[mask].mean(keepdims=True), ent[mask].mean(keepdims=True)))
    return out


def print_diagnosis(rows: list[tuple]) -> None:
    total = sum(float(r[1][0]) for r in rows if r[0].startswith("回合"))
    if total <= 0:
        return
    print("\n分桶诊断（占比 · 平均优势 · Δlogp · 熵）")
    for name, n, a, d, e in rows:
        share = float(n[0]) / max(1.0, float(sum(float(r[1][0]) for r in rows if r[0].startswith("回合"))))
        flag = ""
        if abs(float(d[0])) < 1e-4 and abs(float(a[0])) > 0.2:
            flag = "  ← 有信号但几乎没动"
        print(f"  {name:<14} {share * 100:5.1f}%  adv {float(a[0]):+7.3f}  Δlogp {float(d[0]):+.2e}  H {float(e[0]):.3f}{flag}")
