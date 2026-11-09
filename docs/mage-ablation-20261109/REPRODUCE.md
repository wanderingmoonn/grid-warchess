# 法师三组件拆分实验复核

三组各4局新对局，共12局：只先升级0胜2负2上限未决；只分批采购1胜2负1上限未决；只站位调整0胜3负1上限未决。原始4局为1胜3负。另保留上一轮组合4局作背景参考，共20局原生动作回放；没有额外计入诊断探针或旧样本作为新比赛。

## 独立解压后的复核

需要Node.js24（实测24.21.0）。解压`reproduction.zip`到新目录，在根目录运行：

```powershell
node --experimental-strip-types replay-all.mjs
```

命令先检查`bundle-manifest.json`中全部文件的SHA-256，运行自带的15项新测试、12项前轮测试、三组源码隔离检查，再用冻结原生规则重新执行原始4局、上轮组合4局、本轮12局的每一个动作，并重算采购、伤害、死亡、局部站位探针与汇总。最终要求`comparison.json`逐字节一致。会重写派生分析文件，不会修改原始压缩回放或新增胜负样本。

`reference/original/`和`reference/combined/`分别存旧原始与旧组合的4局；为使提取器可独立运行，各自`protocol.json`仅保留所需4项任务，原协议完整副本为`original-protocol.json`。规则、配置、输入和每局原始结果不变。`test-core/`是供定向测试使用的前轮冻结源码加新实验辅助函数；运行比赛使用的是`snapshot/`和`variants/`。

## 从AI入口重新计算12局

使用尚不存在的新输出目录，保留当前证据：

```powershell
node fresh-rematch.mjs --out ../fresh-mage-components
```

它复制全部封存输入并调用原`run.mjs`，最多同时运行12个进程，每个堆上限1536MB。耗时受硬件影响。比较动作哈希、胜负和原生统计，不比较时间、内存或回放生成日期。在原解压目录直接调用`run.mjs`会复用已完成缓存。

`prepare.mjs`保留用于审查适配过程；已有`seal.json`时拒绝再准备。三组源码差异记录在`source-deltas.json`，逐项逆向恢复后必须与原AI一致；对局脚本同样可逆向恢复成原统计脚本。每组只有一个配置组件，规则和兵种文件逐一保持原哈希。

## 组件和解释边界

- 先升级：在首位法师前满足原价升级加1名法师预算、且可见敌军未迫近时，先升四代；随后继续原采购协议。升级支出会自然推迟买法师，这属于组件的后续影响。
- 分批采购：首批4名每己方回合最多1名，并为下一名保留金币。没有再区分频率限制与现金预留这两个操作；不启用先升级、混编比例或站位规则。
- 站位调整：只复用上一轮法师移动和原地候选的评分偏置；其他兵种和采购代码原样。

上一轮组合还包含普通采购混编过滤、骑士长策略，不是只有这三个开关的同一析因单元。因此只作参考，不用它分配三项贡献或估计交互项。两张图换座不是4张独立地图；达到200单方回合上限但没有赢家的比赛单列未决。

输出分全局付费法师与每局首批4名两种口径。首批预算均为每局600金，可避免只因后续购买数量不同造成的误读；出兵时点、阵容和对局时长仍然不同。站位风险探针只看当时可见且固定位置的敌军，不覆盖移动、隐藏单位或集火。它不是整局替代策略模拟。

## 完整仓库检查与绘图

GitHub实验分支只新增实验函数和测试，不再次改动默认AI、兵种数值或规则。检出分支并安装锁定依赖后，可运行：

```powershell
node node_modules/typescript/bin/tsc --noEmit
node --experimental-strip-types scripts/test-ai-mage-experiment.ts
node --experimental-strip-types scripts/test-ai-unit-strategy.ts
node --experimental-strip-types scripts/test-ai-optimization.ts
node --experimental-strip-types scripts/test-ai-evaluation.ts
node --experimental-strip-types scripts/test-rules.ts
node --experimental-strip-types scripts/test-replay-file.ts
node node_modules/vite/bin/vite.js build
```

干净源码通过新测试15、前轮策略12、AI51、评测7、规则580、回放9，以及类型检查和构建。全部日志在`checks/`；三组冻结控制器另通过独立类型检查。`experiment.patch`是相对前轮提交新增的两个源码/测试文件；控制器接入差异在`source-deltas.json`。

绘图需要Python与Matplotlib3.11.2，运行`python plot_comparison.py`读取已核验的`comparison.json`生成`assets/`。实测使用Windows微软雅黑；其他系统需配置可用中文字体。图形依赖不参与对局和回放验证。
