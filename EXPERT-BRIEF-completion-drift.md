


## 1. 一句话问题

流式回复在**结束时刻**，整屏文本相对“流式中钉住的位置”会发生几十像素的漂移
（本日志表现为：完成窗口内 pad 从 38→60px 膨胀，随后以 ~1px/帧、约 1 秒把整个会话
**往下滑 60px** 才“归位”），并伴随多写者抢 scrollTop 造成的抖动。
历次修复都只动引擎内部，未解决**引擎与宿主两套 follow 控制器抢同一 scrollport** 的结构性问题。

## 2. 代码状态与日志版本对应（必须先对齐，否则分析全错）

- 本仓库：`/Users/dzlin/work/project/dsh-smooth-stream`
- 引擎主文件：`src/client/teleprompterGlide.ts`（约 2619 行）
- 交接文档：`HANDOFF-completion-jitter.md`（上一轮根因链 + 残余问题，必读）
- 探针：`scripts/probe-host-completion.mjs`（判红工具，自带 “scrollTop 间谍带栈”）

**⚠️ 重要：工作树是脏的，且正在被并行会话修改**（`git status` 显示
`teleprompterGlide.ts` 未提交改动 +48/-17 后又追加了 `rbp`/`rbp-delta`/`mo2` 探针日志，
另有两个未跟踪探针脚本）。**用户贴的日志里没有 `rbp`/`mo2` 行 ⇒ 该日志来自上一个已提交版本
`b02dd20` 的构建**（当前工作树的下一轮尝试尚未 `pnpm build` 进宿主）。

分析基线 = `b02dd20` 的已提交代码；下文行号均为当前工作树（函数名更稳）。

## 3. 症状

- 流式过程中滚动完全平滑（用户确认，多轮未破坏）。
- 结束瞬间：文本出现 Y 轴漂移/往复（单帧跳 + 数帧拉锯 + 随后 ~1s 的慢速下移）。
- 用户原话（2026-09-03）：“流式结束时文本不要 Y 轴往复移动”“最大的问题是流式渲染结束会有位置漂移”。

## 4. 日志逐行解读（时间线重建）

```
[dsh-follow] external-scroll {"from":2221,"to":2243,"ledger":2194}
[dsh-follow] external-scroll {"from":2221,"to":2243,"ledger":2243}
[dsh-follow] settle {"st":2243,"sh":3490,"pad":38,"reserve":0,"lag":31,"retiring":false}
[dsh-follow] settle {"st":2265,"sh":3512,"pad":60,"reserve":0,"lag":45,"retiring":false}
[dsh-follow] retire-start {"pad":60,"sh":3512,"st":2265}
  …（60 帧左右，st/sh/pad 每帧 −1，lag≈0，retiring:true）…
[dsh-follow] settle {"st":2205,"sh":3452,"pad":0,"reserve":0,"lag":0,"retiring":false}
[dsh-follow] finish {"st":2205,"sh":3452,"pad":0}
[dsh-follow] finish-enter {"sh":3452,"st":2205,"pad":0,"retain":true}
```

### 4.1 字段含义（`src/client/teleprompterGlide.ts`）

| 字段 | 含义 | 代码出处 |
|---|---|---|
| `external-scroll` | 引擎在写 scrollTop 前发现**实际值 ≠ 自己上次写入的账本**，即别人动过 | `setFollowScrollTop` L1162-1176（日志 L1168） |
| `ledger` | 引擎上次写入/接受的 scrollTop（`followScrollLedgers`，L1184） | L1171 |
| `settle` | 完成 settle 循环每帧几何快照（仅在签名变化时打印） | L2582 |
| `st` / `sh` | scrollTop / scrollHeight | — |
| `pad` | 引擎在 flow 上持有的“完成垫”（flow 的 padding-bottom），终值必须为 0 | `flowPadOf` L829 / `setFlowPad` L856 |
| `reserve` | 预测性画布预留（流式结束=0，正常） | — |
| `lag` | `sh − animatedH − runwayOffset`：弹簧还差多少追上真实 extent | L2515 附近 |
| `retiring` | 是否处于 pad 退休（最终归位滑行） | — |
| `retire-start` | 退休开始条件：lag≤0.25 且 reserve≤0.25 且静默≥240ms 且 pad>0.25 | L2529 / L2522-2531 |
| `finish` | 收尾：lag、reserve、pad 全 ≤0.25 且静默 240ms | L2551 |
| `finish-enter` | `finishAtNaturalFloor`（L1374-1409）：落底 + 保留合成器 2 帧后清 transform | L1377 |

### 4.2 三条“铁证”（从日志可直接推，无需运行）

**(1) 完成窗口内存在第二个 scrollTop 写者（两次被抢占）。**
- 第一条：`ledger:2194` 但实际 `from:2221` —— 引擎账本比真实位置落后 **27px**，
  这 27px 不是引擎写的（引擎的每一次写都会更新 ledger，L1171）。
- 第二条：引擎刚把 2243 写进 ledger，下一次写前实际又回到 `2221` ——
  **引擎写的 2243 被回退/钳制到 2221**，然后再写才站住。
- 代码注释自己点名：L1164-1166 “a fight between the host's own follow controller
  and this engine is the completion-jitter suspect”。

**(2) +22px 的 pad 膨胀是“误归因”的结果，不是真实布局增长。**
三处状态的一致性：clientHeight（vh）恒为 1247
（3490−2243=1247；3512−2265=1247；3452−2205=1247）；
**内容高 sh−pad 恒为 3452**（3490−38；3512−60；3452−0）。
⇒ 整个窗口真实内容**没有增长**；`sh` 从 3490→3512 的 +22 全部是引擎自己的 pad 项。
而 pad 从 38→60（+22）只能来自 `enforceReadingAnchor` 的 anchor-push 分支
（唯一“新增 extent”的机制；`transferRunwayToFlowPad`/`adoptDeadRunwayToFlowPad` 都不增 extent）。

**(3) 守卫公式无法区分“宿主改了 scrollTop”与“宿主布局把锚点往下推”。**
`measureReadingAnchor` 的 delta 公式（L764）：
`delta = (topΔ) − (shiftΔ) + (floorΔ)`
当宿主把 scrollTop 回写 −22（extent 不变 ⇒ floorΔ=0，shiftΔ=0），锚点 rect.top 上移 +22 ⇒
delta=+22 ⇒ 判为“宿主把内容往下推了” ⇒ 授予 pad +22。
⇒ 一场**纯 scrollTop 抢占被当成布局推送补偿**，产生 22px 可见空间，随后必须退休（可见下移）。
两个 `external-scroll`（2221↔2243）与 pad +22 的数值完全吻合。

### 4.3 最终可见运动预算（用户实际看到什么）

- 完成窗口内的抖动（两次抢占 + lag 31→45 的追平）。
- pad=60px 的退休滑行：设计速率 ~0.8px/帧（72px/1.5s，60Hz），本日志观测到 ~1px/帧×60帧 ≈ 60px/s ≈ 1s。
  这是**设计内的“归位”**（交接文档 §五：用户此前接受 0.8px/帧形态），
  但其中 ≥22px 是被“误归因”灌进去的、本不该存在的下移量。
- 结束状态自洽（pad=0，st=floor，content=3452）——终态没有残留引擎空间。

## 5. 双写者架构：问题的真正所在

两套独立 bottom-follow 控制器，各有自己的账本，没有共享所有权协议：

**引擎（本插件）** `src/client/teleprompterGlide.ts`
- 每帧 `setFollowScrollTop`（L1162）写 scrollTop，账本 `followScrollLedgers`（L1184），
  用 `data-follow-owned` 属性标记“这是我写的”（L1173-1175）。
- 屏幕空间锚点守卫 `enforceReadingAnchor`（L1674-1693）+ `measureReadingAnchor`（L742-782）。

**宿主（deepseek-harness）** `packages/client/ui-chat/src/client/chat/ChatView.tsx`
- 自己的账本 `observedTopRef`（L541 起：`movedByReader = |scrollTop − min(observedTop, floor)| > 0.5`），
  `FOLLOW_THRESHOLD = 24`（L18）。
- **RO 驱动硬贴底**：`followRef`（L585-589）——“while atBottomRef is true → `el.scrollTop = el.scrollHeight`”，
  注释明确“This observer owns ChatView's dynamic-height follow decisions and writes only while the reader is pinned”。
- `toBottom()` 硬快照（L391-397）；锚点保持回写 `el.scrollTop += flowTop(row,el) − anchor.top`（L490）。
- 滚动监听把任何偏离自己账本 >0.5px 的写入分类为“读者滚动”（L541-549）。

**已验证：宿主从不读 `data-follow-owned`**（在 deepseek-harness 仓库 `apps`/`packages` 源码里 grep 为零命中）。
⇒ 引擎的“所有权标记”对这个宿主是**死代码**。引擎每帧写、宿主 RO 贴底、互相把对方当“外来者”纠正。

## 6. 历次修复为什么“无济于事”

git log 相关提交（全部在引擎内部打补丁，未触及双写者边界）：

- `b02dd20` fix: completion anchor hold rebuilt on shared per-port ledger; probe hardened
- `59c5739` fix: pre-paint screen-space anchor hold closes the completion jitter race
- `ac74ea7` fix: Y-axis zero-rebound + completion cascade stability + host drift
- `b14757d` feat: keep aggressive wrap-smooth tail pin with open-tooltip guard
- `9f06078` chore: add smoothness audit harness and follow probes
- `3320436` fix: stabilize stream follow diagnostics
- `9776461` / `da4ee57` fix: stabilize stream completion/follow and announcements
- `de30e05` fix: unify adaptive reveal and conversation follow
- `374a33f` fix: prevent streaming overlap and restore bottom follow
- `b8c5eef` / `1ea27be` / `cf34efb`(revert) 等 follow 相关

`HANDOFF-completion-jitter.md` 记录了**已被钉死的 5 层根因**（每层都有帧级实证）：
换帧重挂臂抢权、monotone ceiling 误诊已删、锚点身份切换误读、pad 退休自激循环（ST-FIGHTS）、
共享屏幕空间锚点账本。症状形态随修复不断变异：170px 单帧跳 → 100-150px 跳 + ±21px 拉锯 → 现在的“漂移”。
**共同模式：每次都在引擎内部再加一层守卫/账本去抵消宿主的行为，从未建立“谁拥有 scrollport”的唯一事实源。**

## 7. 给专家的方向性命题（可检验，非结论）

1. **所有权协议**：宿主要么识别 `data-follow-owned`，要么两套控制器显式握手（单写者 + 显式交接 token）。
   不动宿主的前提下，引擎在完成窗口应**识别外来写者并让位**（退化为“宿主贴底语义”），而不是用 pad 对抗。
2. **守卫公式无法区分 scroll 抢占 vs 布局推送**：delta 计算前先核对
   “extent/floor 是否变化”——若 extent 未变、仅 scrollTop 变 ⇒ 是外来 scroll（重写 floor 即可，**不要授 pad**）。
   当前实现把 scroll 抢占当布局推送补偿，是 pad 膨胀的直接来源（日志铁证 (2)(3)）。
3. **27px 账本陈旧**：窗口开始前已有 27px 的 scrollTop 移动未被引擎记账，需 scrollTop 间谍带栈定位是谁写的。
4. **架构层**：把“谁拥有 scrollport”做成跨仓库的显式状态机（idle→streaming→completion-settle→retired），
   双方共用契约；否则在完成窗口内两套守卫/账本/监听必然互踩。
5. **产品层**：先确认“漂移”的观感目标到底是“归位滑行本身”还是“滑行前的抖动”。
   若 1s 下移就是用户最不满的，方向应是完成窗口**根本不累积 pad**（只用合成器 shift 补偿），
   或把归位分散到流式尾部而不是结束后。

## 8. 还需要的日志/取证（按优先级）

1. **完整完成窗口**：日志窗口在完成 handoff 自动开启 +15s（L2355），无需开关；
   请从“流刚结束”起整段复制（当前粘贴只含尾部，缺 `fast-gate`/`cleanup-dead-margin`/`anchor-push`/`anchor-pull`）。
2. **开启 DevTools 时间戳**（Console → Settings → Show timestamps），对齐帧号。
3. **跑当前工作树探针**（已加 `rbp`/`rbp-delta`/`mo2` 行）：`pnpm build` + 完全重启宿主后
   `node scripts/probe-host-completion.mjs "<ws url>"`（判红工具，含 scrollTop 间谍带栈，见交接文档 §六复现命令）。
4. **定位“写 2221 的人”**：在 `ChatView.tsx` 的 `followRef`（L585-589）与 `toBottom`（L391-397）临时 console
   标记（属于宿主仓库的改动，需征求用户同意），看完成窗口内宿主 RO 是否触发、写了几次。
5. 若可行，抓一帧 `rbp` 看 leaderless/handedOff/storedTop/storedFloor/anchorTop 对照本日志。

## 9. 硬性约束（不变，来自交接文档 §七）

1. 流式期零向下位移（verify-y-rebound 5/5）。
2. 完成态 pad 终值 0，文本紧贴 composer。
3. 弹簧参数不可动：`FOLLOW_SPRING_STIFFNESS=130 / DAMPING=24 / MASS=1 / SUBSTEPS=4`。
4. 台架（audit.html 等）无 `data-chat-flow-kind` —— 依赖行 kind 的逻辑必须 -1 回退。
5. 改 src 后必须 `pnpm build` + **完全重启宿主**（bundle rev 启动时固化）。

## 10. 复现命令（一条序列）

```bash
node scripts/mock-llm-server.mjs > /tmp/dsh-mock-llm.log 2>&1 &
# settings.yaml 的 llm-pi-ai.providers 下加 dsh-mock（apiKeyEnv: DSH_MOCK_KEY,
# api: openai-completions, baseURL: http://127.0.0.1:49731/v1, models: [mock-stream]）
# agent-default-model → provider: dsh-mock + model: mock-stream
cd /Users/dzlin/work/project/deepseek-harness
DSH_MOCK_KEY=mock node --import tsx/esm apps/cli/src/bin.ts web --no-open
node scripts/probe-host-completion.mjs "http://127.0.0.1:3080/?token=<...>"
```
（详细见 `HANDOFF-completion-jitter.md` §六）
