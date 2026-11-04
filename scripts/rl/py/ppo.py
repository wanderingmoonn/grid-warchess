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
    kused: np.ndarray  # [n] 这一步真正有几个候选（不足 K 时尾巴是补零，必须屏蔽）
    manifest: dict

    def __len__(self) -> int:
        return int(self.state.shape[0])


def load_rollout(base: str) -> Rollout:
    """读 `<base>.json` + `<base>.bin`。布局：每步 width 个 float32 平铺。"""
    with open(f"{base}.json", "r", encoding="utf-8") as fh:
        man = json.load(fh)
    width = int(man["width"])
    flat = np.fromfile(f"{base}.bin", dtype="<f4")
    if flat.size % width != 0:
        raise ValueError(f"采样文件长度 {flat.size} 不是 {width} 的整数倍——多半是上次没写完")
    rows = flat.reshape(-1, width)

    s_dim, a_dim, k = int(man["state"]), int(man["action"]), int(man["k"])
    state = rows[:, :s_dim].copy()
    cand = rows[:, s_dim : s_dim + k * a_dim].reshape(-1, k, a_dim).copy()
    tail = s_dim + k * a_dim
    logp = rows[:, tail + 0].copy()
    value = rows[:, tail + 1].copy()
    reward = rows[:, tail + 2].copy()
    idx = rows[:, tail + 3].astype(np.int64)
    game = rows[:, tail + 4].astype(np.int64)
    kused = rows[:, tail + 6].astype(np.int64) if rows.shape[1] > tail + 6 else np.full(len(rows), k)
    return Rollout(state, cand, idx, logp, value, reward, game, kused, man)


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
    for g in np.unique(rollout.game):
        sel = np.where(rollout.game == g)[0]
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
            stats["ratio_mean"] = float(ratio.mean())
            stats["clip_frac"] = float(((ratio - 1).abs() > cfg.clip).float().mean())

    # 近似 KL（旧策略 || 新策略），PPO 调参最常看的那个数
    with torch.no_grad():
        logits, _ = model(st, cd, ku)
        new_logp = torch.log_softmax(logits, dim=-1).gather(1, ix.unsqueeze(1)).squeeze(1)
        stats["approx_kl"] = float((old_logp - new_logp).mean())
    return stats
