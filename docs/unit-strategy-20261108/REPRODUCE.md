# 复核本轮策略与12组配对结果

本目录附带原测12局和候选策略12局的原生动作回放。最终结果：戈兵3胜1负保持一致；法师1胜3负变为0胜3负1上限未决；神圣骑士长0胜3负1上限未决变为2胜1负1上限未决。未改兵种数值，未按胜负调整封存策略。

## 直接检查与原生重放

需要Node.js 24（实测24.21.0）。解压`reproduction.zip`到新目录，在解压根目录运行：

```powershell
node --experimental-strip-types replay-all.mjs
```

该命令先核对`bundle-manifest.json`中的全部SHA-256，再用冻结的原生规则重新执行原/新各12局的每一个动作，重算采购、伤害、死亡、圣旗局部消融、站位探针与汇总，并要求`comparison.json`逐字节一致。它不会训练AI、改变兵种定义或新增胜负样本；运行期间会重写派生分析文件。

`reference/protocol.json`只保留本轮比较所需的12项任务，配置、代码指纹和每局输入不变；完整的原测协议保存在`reference/original-protocol.json`。`reference/games/`与`games/`分别是原/新的12局结果和压缩回放。`baseline/core/`、`candidate/core/`分别是对局使用的核心，`snapshot/core/`是供原分析器使用的基线副本。

## 重新计算12局候选AI对局

若要从决策入口重新计算比赛，使用另一个尚不存在的输出目录，保留原始证据：

```powershell
node fresh-rematch.mjs --out ../fresh-unit-rematches
```

该命令复制封存的协议、双核心和对局脚本，启动同样的12局。原`run.mjs`最多同时运行12个进程，每个进程堆上限1536MB；耗时受硬件影响。比较结果时使用动作哈希、胜负和原生统计，不比较耗时、内存或回放生成时间。原样运行解压目录内`run.mjs`会使用已完成缓存。

`prepare.mjs`是封存前适配脚本，保留用于审查；已有`seal.json`时它拒绝再次准备。无需运行它。

## 源码测试

GitHub实验分支以冻结的原测核心为基线。检出候选分支、安装其锁定依赖后，可运行：

```powershell
node node_modules/typescript/bin/tsc --noEmit
node --experimental-strip-types scripts/test-ai-unit-strategy.ts
node --experimental-strip-types scripts/test-ai-optimization.ts
node --experimental-strip-types scripts/test-ai-evaluation.ts
node --experimental-strip-types scripts/test-rules.ts
node --experimental-strip-types scripts/test-replay-file.ts
node node_modules/vite/bin/vite.js build
```

发布源码在干净检出上通过：策略12项、AI51项、评测7项、规则580项、回放9项，以及类型检查与构建。完整日志在`checks/`。`candidate.patch`精确列出相对冻结基线的3个AI文件和1个新增测试；未包括原工作区其他未提交内容。`tests/test-ai-unit-strategy.ts`是测试源副本，实际运行路径为仓库中的`scripts/`。

## 计算与绘图含义

`validate-and-compare.mjs`核对12对起始状态和开发动作前缀哈希、配置、规则版本v4、迷雾、预算和全部封存哈希。`extract-new.mjs`重放每个合法动作并核对最终赢家/回合/金币与单位伤害。`probe-new.mjs`只做局部合法动作诊断；可见敌军固定位置风险不包含移动、集火或隐藏敌军。

圣旗消融每次从真实动作前局面开始，只移除己方圣旗buff、重放同一动作，然后恢复真实局面；不是无圣旗整局模拟。即时HP伤害、单位支出比也不是胜率。达到200单方回合但没有赢家的对局单列“上限未决”。两张图换座不是4张独立地图，未以本轮重新标定评分。

绘图需要Python和Matplotlib3.11.2：安装该版本后运行`python plot_comparison.py`即可读取`comparison.json`重建`assets/`。实测用Windows微软雅黑字体；其他系统需自行配置可用的中文字体。绘图依赖不参与比赛或回放验证。
