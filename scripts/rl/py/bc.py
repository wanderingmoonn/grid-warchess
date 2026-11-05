"""行为克隆：把「老师（手写 AI）在这一步选了哪个」当成分类标签，直接把打分网络练出来。

── 这一步在整条链上的位置 ──────────────────────────────────────────────

    imitate.ts（录 AI 的选择） → bc.py（监督学习） → rollout/train（PPO 继续练）

为什么必须先做它：从随机权重上跑 PPO，采样是 960 局全败——每步的终局奖励都是 −1，
优势里没有"这一步比那一步好"的对比，梯度是噪声。BC 用**老师的动作**当标签，
把"哪一步更好"这个信息直接灌进去，几万个样本就能把策略从"不会下棋"抬到"像老师"。

── 只练打分头，不练预筛 ────────────────────────────────────────────────

和 PPO 侧同一条约定：预筛（线性）冻结在权重文件里，候选集因此在训练和推理时是同一批。
如果这里连预筛一起练，候选集会随训练漂移，每一行存的候选特征就和"当前策略会看的候选"
不是一回事了——那是 PPO 侧踩过的坑（见 ppo.py 的说明），不加区分地重犯没有意义。

用法：
    .venv/Scripts/python.exe scripts/rl/py/bc.py \\
        --data .tmp/bc/data --weights scripts/rl/weights/init.json \\
        --out .tmp/bc/w-bc.json --epochs 8 --lr 1e-3
"""

from __future__ import annotations

import argparse
import json

import numpy as np
import torch

import net
import ppo


def load_bc(base: str):
    """读 `<base>.json` + `<base>.bin`，返回 (state, cand, label, kused, vt)"""
    man = json.load(open(f"{base}.json", encoding="utf-8"))
    width = int(man["width"])
    flat = np.fromfile(f"{base}.bin", dtype="<f4")
    rows = flat.reshape(-1, width)

    s_dim = int(man["state"])
    a_dim = int(man["action"])
    slots = int(man["slots"])
    tail = s_dim + slots * a_dim

    state = rows[:, :s_dim].copy()
    cand = rows[:, s_dim:tail].reshape(-1, slots, a_dim).copy()
    label = rows[:, tail + 0].astype(np.int64)
    kused = rows[:, tail + 1].astype(np.int64)
    vt = rows[:, tail + 2].astype(np.float32)
    return state, cand, label, kused, vt, man


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--weights", required=True, help="模板权重（预筛和结构从它来）")
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--batch", type=int, default=4096)
    ap.add_argument("--label-smooth", type=float, default=0.05, help="标签平滑，防止熵被压到 0")
    ap.add_argument("--vf-coef", type=float, default=0.3)
    ap.add_argument("--ent-coef", type=float, default=0.002)
    ap.add_argument("--val-frac", type=float, default=0.1, help="留出多少做验证（按局切，不按步切）")
    args = ap.parse_args()

    state, cand, label, kused, vt, man = load_bc(args.data)
    n = len(state)
    games = int(man["games"])

    # 按**局**切验证集：同局的相邻步高度相关，按步随机切会让验证准确率虚高
    n_val = max(1, int(games * args.val_frac))
    val_games = set(range(games - n_val, games))
    is_val = np.isin(np.fromfile(f"{args.data}.bin", dtype="<f4").reshape(-1, man["width"])[:, man["state"] + man["slots"] * man["action"] + 3].astype(np.int64), list(val_games))
    tr = np.where(~is_val)[0]
    va = np.where(is_val)[0]

    print(
        f"数据：{n} 条决策 / {games} 局（跳过 {man.get('skipped', 0)} 步：老师的动作不在合法枚举里）"
        f" · 训练 {len(tr)} / 验证 {len(va)}"
    )
    print(f"  价值目标分布：{np.bincount((vt + 1).astype(np.int64), minlength=3).tolist()}（[负, 平, 胜]）")

    w = net.load(args.weights)
    model = ppo.TorchPolicy(w)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)

    st = torch.from_numpy(state)
    cd = torch.from_numpy(cand)
    lb = torch.from_numpy(label)
    ku = torch.from_numpy(kused)
    vt_t = torch.from_numpy(vt)

    def run(idx: np.ndarray, train: bool) -> tuple[float, float, float, float]:
        """返回 (CE, top1 命中率, 价值 MSE, 熵)"""
        ce_sum = 0.0
        hit = 0
        v_sum = 0.0
        e_sum = 0.0
        order = np.random.permutation(idx) if train else idx
        for start in range(0, len(order), args.batch):
            sel = order[start : start + args.batch]
            if len(sel) < 2:
                continue
            logits, value = model(st[sel], cd[sel], ku[sel])
            logp = torch.log_softmax(logits, dim=-1)
            # 标签平滑：目标分布 = (1-ε)·onehot + ε/k，防止把熵压到 0（探索死掉就没法继续 PPO）
            #
            # 这里踩过一个很隐蔽的坑：`torch.full_like(lb[sel], 1-ε)` 会**跟着 lb 的 dtype
            # 走**，而 lb 是 int64 —— 0.95 被截成 0，于是目标分布的总质量只剩 ε（0.05），
            # 交叉熵整体缩小 20 倍，看起来"CE 一直是 0.338 不降"，其实是梯度小到没动静。
            k = logits.shape[1]
            tgt = torch.full((len(sel), k), args.label_smooth / k, dtype=logp.dtype)
            tgt.scatter_add_(
                1,
                lb[sel].unsqueeze(1),
                torch.full((len(sel), 1), 1.0 - args.label_smooth, dtype=logp.dtype),
            )
            # 补零的候选被 masked_fill 成 −inf，logp 也是 −inf；那边 tgt 恰好是 ε/k，
            # 直接乘会得到 0×(−inf)=nan（第一次跑出来 CE=inf 就是这个）。先夹住再乘。
            ce = -(tgt * logp.clamp(min=-30.0)).sum(dim=-1).mean()
            vloss = torch.nn.functional.mse_loss(value, vt_t[sel])
            probs = torch.softmax(logits, dim=-1)
            ent = -(probs * torch.log(probs + 1e-9)).sum(dim=-1).mean()
            loss = ce + args.vf_coef * vloss - args.ent_coef * ent
            if train:
                opt.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                opt.step()
            ce_sum += float(ce.detach()) * len(sel)
            v_sum += float(vloss.detach()) * len(sel)
            e_sum += float(ent.detach()) * len(sel)
            hit += int((logits.argmax(dim=-1) == lb[sel]).sum())
        m = max(1, min(len(order), len(idx)))
        return ce_sum / m, hit / m, v_sum / m, e_sum / m

    best = None
    best_state = None
    for ep in range(args.epochs):
        ce, acc, vloss, ent = run(tr, True)
        vce, vacc, vv, vent = run(va, False)
        print(
            f"  第 {ep + 1} 轮  训练 CE {ce:.3f} · top1 {acc * 100:5.1f}%   "
            f"验证 CE {vce:.3f} · top1 {vacc * 100:5.1f}% · 价值 MSE {vv:.3f} · 熵 {vent:.3f}"
        )
        if best is None or vacc > best[0]:
            best = (vacc, ep + 1)
            # 留一份最好的：BC 只有几万样本，过拟合来得很快，
            # "最后一轮"经常不是"最好那一轮"，直接导出最后一轮等于白挑
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}

    print(f"最好的验证 top1 出现在第 {best[1]} 轮（{best[0] * 100:.1f}%），导出的是那一轮的权重")
    if best_state is not None:
        model.load_state_dict(best_state)
    out = model.to_weights(w)
    net.save(args.out, out)
    print(f"权重 → {args.out}（预筛原样沿用 {args.weights}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
