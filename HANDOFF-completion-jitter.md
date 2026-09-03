# 交接文档：流式完成时刻的滚动抖动——根因链与残余（2026-09-03）

> 写给下一位接手者。所有结论均来自真实宿主（deepseek-harness web profile）+ mock 流端到端帧级实测，
> 探针与判据已固化在本仓库 `scripts/probe-host-completion.mjs`，可直接复现。

## 一、用户诉求与现状

- 用户诉求（2026-09-03 原话）：流式结束时文本不要 Y 轴往复移动，"最好能稳定些"。
- 流式过程中滚动完全平滑（用户确认，多轮验证未破坏）。
- 本轮后实测形态（两次探针完全一致，确定性达标）：
  1. 交换帧（turnStatus 卸载/turn-process、turn-tail 挂载同帧）：assistant 渲染位置**单帧上跳 ~100-150px**；
  2. 交换后 3 帧：±21px 的拉锯（守卫过补偿 ~22px/帧 × 3，pad 耗尽后收敛）；
  3. 之后进入 1.5s 限速归位（0.8px/帧，用户已接受该形态）。
- 对比本轮开始：单帧跳变 170px、且存在（后来发现的）退休-重发无限循环的隐患。

## 二、本轮钉死的完整根因链（五层，全部有帧级实证）

1. **完成级联帧会重挂 FollowHost 臂**：live→settled 交换时 React 重渲染节点视图，
   settled 侧新臂以更高 generation 在 layout effect 里同步 prime，`hold()` 从正在排水的
   settle 循环手里**抢走领导权**（探针实证 `lead-take gen:7 st:1179` 与交换帧同帧）。
2. **抢权后无人能补交换帧**：前任臂的观察器因 `!isLeader` 跳过（`rbp-skip` 风暴）；
   新臂的 MutationObserver 是在变异之后才 observe 的，**收不到那批记录**；
   新臂 prime 的 `measureReadingAnchor` 只刷新基线——把已发生的跳变**采纳为新基线**。
3. **ceiling 方案（上一轮）被证伪并移除**：`setDirectShift` 的 WeakMap 单调上限把 settle 循环的
   锁步补偿钳死（交换帧 shift 该抬 +133 被钳到 28），还把 ceiling 棘轮下拧**把跳变锁进画面**；
   且 transform 增长 ≠ 文本移动——同帧 extent 增长下的 shift 抬升是**补偿**（净位移 ≈0）。
   以"transform 单调"为判据是误诊，已全部删除。
4. **旧守卫锚定 `shiftSurfacesOf(port).at(-1)` 会随级联换身份**：tail/process 行挂载后
   `at(-1)` 从 assistant 行切换到新行，把"tail 出现在视口内"测成 >1000px 的向下推，
   pad 被灌到 212px，再花 4 秒退休——"上跳 + 缓动下沉"的往复即此。
5. **pad 退休的自身滑行会被守卫误判**：守卫若不排除 pad 项，退休（pad −δ → 内容下移 δ）
   被读成宿主下推 → 重新 grant pad → **退休-重发无限循环**（ST-FIGHTS 栈实证 settleFrame
   在流结束后 19s 仍以 ~2.9s 周期反复 1061↔1177）。修复 = 锚点基线同时存储 shift 与 pad，
   宿主增量 = `topΔ − shiftΔ + padΔ`。

## 三、本轮落地的修复（均已提交/在工作区）

引擎（`src/client/teleprompterGlide.ts`）：
- 移除整套 monotone shift ceiling（含 `setDirectShift` 的钳制、settle 的棘轮、handoff 的武装）。
- **共享屏幕空间锚点** `followGuardAnchors`（per-port，含 element 身份 + top + shift + pad），
  所有臂与 settle 读写同一基线 → 守卫幂等（先到者补偿、后到者测得 ≈0）。
- **锚点 = 阅读行**（`readingAnchorOf`：flow 子节点中最后一个 kind=assistant 或含 think 的行），
  并带 flow 子节点索引：同槽位且旧节点已断开 = live→settled 原位替换 → 桥接保持阅读位置；
  新回合行追加（旧节点仍连接）→ 重置基线不补偿。
- **`enforceReadingAnchor`**：push（宿主下推 → grant pad）、pull（上推 → 先释放 pad、
  pad 不足用 shift raise 补齐并 `animatedH -= raise` 使抬升在弹簧模型中粘住）、deadband 跟踪。
  补偿后基线存**补偿后的保持位置**（部分补偿单调收敛，不振荡）。
- **完成 settle 所有权**（`followCompletionSettle` + 用户行计数）：settle 排水/退休期间
  swap 重挂臂不得抢领导权、不得 reclaim pad、不得刷新共享基线；真正的新回合
  （用户行数增长）正常接管。宿主无 `data-chat-flow-kind` 属性（引擎自带台架）时自动禁用。
- 流式期守卫退化为原始语义（push 保留、pull 仅释放 pad、**无 raise**）——否则与活动循环的
  wrap 锁步打架，冻结揭示（verify-y-rebound 600CPS 场景曾因此红，已修复恢复 5/5）。
- jsdom 零矩形（gBCR 恒 0）时跳过屏幕测量——单测环境免疫。

探针（`scripts/probe-host-completion.mjs`，判红工具，本轮大幅强化）：
- 模型路由校验修复：aria 里 `deepseek-official/mock-stream` 含 "mock-stream" 子串但路由到
  无 key 内置 provider——必须校验 `dsh-mock/` 前缀，否则静默不发流、误报 tail=missing。
- 判据改为**屏幕空间**：完成窗内单帧 |aTopΔ|>10px（可见跳变，双向）、userDown>2px；
  transform 增长不再判 FAIL（是补偿不是反转），改为打印 clamp-event 信息行。
- 行元素身份追踪（WeakMap 计数器）、MO/RO 记录分类、scrollTop 间谍带栈、全量过滤日志。
- 已知坑：mock LLM 服务器（:49731）可能中途死掉，探针前先 `curl /v1/models` 探活；
  宿主 token 含 `_`/`-`，`grep -o 'token=[^ ]*'` 取全。

## 四、闸门现状（会话内多次实测）

| 闸门 | 现状 | 基线(4b8677f) | 说明 |
|---|---|---|---|
| 单测 | 203/203 ✓ | 203/203 | |
| verify-y-rebound | 5/5 ✓ | 5/5 | 600CPS 曾红（流式守卫打架），已修 |
| verify-overflow | 10/10 ✓ | 10/10 | 台架 kind 缺失导致 6/10，已修 |
| run-render-audit | **9/10** | 10/10 | burst-gap/ramp 偶发 1px/帧 quiescence-move（见五-3） |
| probe-host-multiturn | adopt -92px | **同 -92px** | 基线既有，非本轮回归 |
| probe-host-completion | FAIL（1 跳 + 3 拉锯帧） | FAIL（1 跳 170px） | 见五-1/五-2 |

## 五、给接手者的下一步（按优先级）

1. **交换帧 -100~-150px 上跳**：交换的多批 React 提交（status 卸载→extent 增长→settled 重排）
   使 gen5 守卫与 settle poll 各补到一部分，仍漏大头。方向：在 settle 所有权保护下，
   让 settle 循环的 poll 在交换后的前 2-3 帧用**全部三项账本差**（top/shift/pad 之外再加
   runwayOffset 项）做一次性总补偿，而不是逐帧追。
2. **交换后 3 帧 ±21px 拉锯**：`pullReadingAnchorBack` 每帧过补偿 ~22px（补偿的 rendered
   效应与下一帧宿主重排存在相位差）。方向：pull 分支加每帧限速（如 ≤8px/帧，复用
   FOLLOW_PAINT_SHIFT_MAX_STEP_PX），或交换后静默 2 帧再一次性补偿。
3. **audit 9/10 的 quiescence-move**：跑道→pad 转移期间 ~1px/帧残余位移。已证伪两个方向
   （去掉 settle 的 `animatedH += transferredPx` 会令 burst-gap 恶化到 40-57 次——弹簧停滞；
   改回 160ms 退休会恶化到 5/10——幅度变大）。该转移的账本在 settle 与 applyVisual 的
   offsetHistory rebase 之间可能存在真实的 δ 残差，需在台架里对 sh 做逐帧断言定位。
4. probe 判据阈值（10px/2px/2.5px）按用户实际观感校准后再定为门禁。

## 六、复现环境（一条命令序列）

```bash
# 1. mock LLM（临时，测完删 settings 里的 dsh-mock）
node scripts/mock-llm-server.mjs > /tmp/dsh-mock-llm.log 2>&1 &
# 2. settings.yaml 的 llm-pi-ai.providers 下加 dsh-mock（apiKeyEnv: DSH_MOCK_KEY,
#    api: openai-completions, baseURL: http://127.0.0.1:49731/v1, models: [mock-stream]）
#    且 agent-default-model 需 provider: dsh-mock + model: mock-stream
# 3. 起宿主（lib rev 启动时固化：改 src 必须 pnpm build + 完全重启）
cd /Users/dzlin/work/project/deepseek-harness
DSH_MOCK_KEY=mock node --import tsx/esm apps/cli/src/bin.ts web --no-open
# 4. 探针（token 从宿主日志取，含 _ 和 -）
node scripts/probe-host-completion.mjs "http://127.0.0.1:3080/?token=<...>"
```

## 七、硬性约束（不变）

1. 流式期零向下位移（verify-y-rebound 5/5，glide-aware 豁免）。
2. 完成态不残留引擎空间（pad 终值 0，文本紧贴 composer）。
3. 弹簧参数不可动：`FOLLOW_SPRING_STIFFNESS=130 / DAMPING=24 / MASS=1 / SUBSTEPS=4`。
4. 台架（audit.html 等）无 `data-chat-flow-kind`——任何依赖行 kind 的逻辑必须带 -1 回退。
5. 改 src 后必须 `pnpm build` + **完全重启宿主**（bundle rev 启动时固化）。
