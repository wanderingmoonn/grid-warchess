# 三个兵种的回放复核证据

本目录对应2026-11-08对法师、神圣骑士长、戈兵的专项复核。主报告在上一层的`UNIT-MISMATCH-REVIEW-2026-11-08.md`。游戏兵种数值、AI策略文件和原始对局动作均未修改。

`review-summary.json`保存可读的逐局结果、现金门槛、伤害归因、技能覆盖和局部探针汇总。`code-evidence.txt`是实际冻结代码的带行号摘录。`assets/`中的两张图分别展示首轮现金门槛和圣旗的局部保护差额。

## 完整复现

下载并解压`reproduction.zip`后，在解压目录运行：

```powershell
node --experimental-strip-types extract-replays.mjs --benchmark ./benchmark
node --experimental-strip-types probe-mechanics-and-positioning.mjs --benchmark ./benchmark
node summarize-review.mjs --benchmark ./benchmark
node verify-review.mjs --benchmark ./benchmark
```

已在Node.js 24.21.0验证。过程重放既有动作、执行局部规则探针，不会再运行完整AI对局。第一步会生成后续探针所需的`key-frames.json.gz`。输出写在分析脚本所在目录，不改`benchmark/snapshot/core/`或`benchmark/games/`。

复现包包含完整冻结规则与AI源文件、12局受测样本、4局同阶段基线、原实验协议、三个兵种的原评分和预计算分析。它不是当前`main`的源码替代品，也不向游戏源码目录应用任何改动。逐文件SHA-256见`manifest.json`，公开目录中的`reproduction-manifest.json`内容相同。

其中原生回放使用原实验固定的`at`展示日期；不要将它解释为对局实际执行时间。动作索引和坐标均从0开始。

## 重新绘图

```powershell
python -m pip install --target ./plot-runtime -r requirements.txt
python plot_review.py
```

图表已在Windows、Python 3.14、Matplotlib 3.11.2及微软雅黑字体环境验证。图表数据来自`review-summary.json`。绘图依赖只需用于重新生成图片，Node回放复核不依赖Python。其他系统需要将绘图脚本中的字体路径改为当地可用的中文字体。

## 指标边界

- 已购单位按原基准口径追踪，包含后续正常招募；复活单位不自动并入。
- 即时兵伤不是全部战斗收益，不包括持续毒烧、自动塔火和未归因的间接作用。
- 圣旗保护值是每步恢复真实前态、只移除增益后重算同一动作得到的HP差额，不是无圣旗完整对局的因果效果。
- 走位探针只看行动前可见的静止敌军，不包含敌军未来移动、多发攻击和集火。合法替代动作不等于更优完整策略。
- 每种仍只有两张固定图、各换座，共4局；本复核没有新增对局，也不推断精确评分或胜率。
