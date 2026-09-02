# 交接文档：流式结束时刻的滚动位置抖动（未彻底修复）

> 2026-09-02。写给下一位接手者。所有数据均来自真实宿主（deepseek-harness web profile）+ mock LLM 流式端到端实测，非推测。

## 一、问题现象（用户视角）

- **流式过程中**（回复正在逐字输出时）：滚动完全平滑，无任何问题（用户确认"稳定性非常好"）。
- **流式结束时刻**（回复输出完成、宿主收尾）：对话内容发生**可见的位置抖动**——整个文本列瞬时下坠/上跳数像素到数十像素。用户原话："结束的时候仍然会发生位置抖动"。
- **历史演变**：
  1. 最初：结束时出现 68~97px 的多帧猛坠（已修复，见下文）。
  2. 修复后：稳定性好，但引擎保留的空间变成文本与输入框之间的永久空白（用户截图红框）→ 用"pad 退休滑行"修复。
  3. 现在：**结束时刻仍有残留抖动**（实测每次完成 1~2 次 painted layout-shift，约 0.011~0.012 值 ≈ 8~15px；部分运行为 0）。

## 二、系统架构与文件地图

**插件（本仓库，工作目录 `/Users/dzlin/work/project/dsh-smooth-stream`）**：
- `src/client/teleprompterGlide.ts`（~2100 行）— 跟随引擎核心：
  - 每帧把 scrollTop 钉在 floor（= scrollHeight − clientHeight），视口始终贴内容底部；
  - 揭示滞后以合成器 transform（`translate3d`，正向=下移）画在流行上；
  - "预留跑道"= 挂在 TurnStatus 行 `marginTop` 上的 0~72px margin（随揭示速度爬升），新行落在该间隙里；换行周期：floor +L、shift +L 同帧抵消 → shift 限速衰减（8px/帧）→ 内容平滑上行一行；
  - 完成期 settle 循环（cleanup 里启动）：排空弹簧 lag → 把 margin 逐帧搬进 flow 的 `paddingBottom`（"pad"，extent 守恒）→ 静默 240ms → **pad 退休段**（0.45px/ms 限速把 pad 还给布局，floor 随之下沉、视口平滑下滑到自然位置）。
- `src/client/FollowHost.tsx` — 组件封装（挂 useConversationFollow）。
- `src/client/TypewriterAssistantNodeView.tsx` — 真实节点视图：**两个 FollowHost 臂**（352 行 per-block、660 行 root）；流式结束时有 **live→settled 交换**（打字机渲染换成静态 markdown，React 会 re-key/替换 assistant 行元素！）。
- `src/client/useSmoothStreamContent.ts` — 打字机揭示引擎（本问题未改动，工作正常）。

**宿主（`/Users/dzlin/work/project/deepseek-harness`，用户以 `pnpm dsh web` 或 `node --import tsx/esm apps/cli/src/bin.ts web` 启动）**：
- `packages/client/ui-chat/src/client/chat/ChatView.tsx` — 宿主**自己的**滚动控制器（与插件引擎并行运行、共享同一个滚动容器！）：
  - `toBottom(el)`（~392 行）：`el.scrollTop = el.scrollHeight` —— 硬钉到全部 extent；
  - ~518 行：`if (appendedUser || … || (tipMoved && atBottomRef.current)) toBottom(el)` —— **tail 签名一变就硬钉**，运行在 layout effect（绘制前）；
  - ~486-497 行：anchored-prepend 路径：`el.scrollTop += flowTop(row, el) − anchor.top`（可向任意方向调整）；
  - ~528-563 行 onScroll：用 observed-top 账本做"是否读者滚动"归因；非 at-bottom 时 `chatScroll.save(position)` 保存锚点。
- 插件经 `~/.dsh/profiles/web/node_modules/dsh-smooth-stream`（`link:` → 本仓库）注入，宿主服务的 client bundle 由各插件的 `lib/client.js` 合并而成（`/plugins/??…&rev=hash`），**rev 在宿主启动时计算**——改源码后必须 `pnpm build`（tsdown → lib/）+ 完全重启宿主。

## 三、完成时刻的宿主动作序列（帧级实测）

回复流式结束（生产者 complete → 揭示排空）前后，宿主在一个到几个提交里做：

1. `turnStatus` 行（高 26px，其 marginTop 上骑着引擎最多 72px 的跑道 margin）**卸载**；同帧一个 `turn-process` 行（41px）在 **assistant 行上方**挂载。净 extent **−53 ~ −97px**（一帧）。
2. **live→settled 交换**：React 替换 assistant 行的 DOM 元素（re-key）——引擎写在旧行上的 margin **随元素死亡**；新行没有任何 margin。
3. 三个高度为 0 的 `input-message` 行（model-retry ChatNodeSeat）位于 process 行与 assistant 行之间。
4. `turn-tail` 指标行（~28px）在 assistant 下方挂载（用户截图中的"用量 x tok · 用时 x 秒"行）。
5. Think 块自动折叠（AnimatedDisclosure 的 grid-rows 过渡，在 assistant 行内部，实测 ~180px）。
6. 宿主自身的 composer/header 区也在此窗口重排（layout-shift 的 sources 含 `unmL2W_trailing`、`hvvBTq_headerActions`——这些在滚动容器之外/属于宿主 chrome）。

**几何本质**：滚动视口全程钉在 floor（= extent − clientH）。extent 任何收缩 → floor 下沉 → 浏览器把 scrollTop 钳制下调 → **全部可见内容整体下移**。这就是抖动的物理来源；extent 任何增长则反向。

## 四、当前修复方案与已验证效果（提交 ac74ea7 + 59c5739）

引擎在 flow 元素（`[data-chat-flow]`，宿主从不重写其内联样式——minHeight 先例）上维护一个 **pad（paddingBottom）**，把宿主级联造成的 extent 损失**同帧补回**，使 extent/floor/scrollTop/内容像素全部静止：

- 守卫点 1：`restoreBeforePaint`（RO + notifyFollowCommit 路径，**绘制前**）；
- 守卫点 2：settle 循环（rAF）；
- 守卫点 3：cleanup 的死 margin 精确转换（registry 元素 `!isConnected` 时 `setFlowPad(+offset)` + `pruneDeadRunway` + `reservePx = 0`）；
- 补偿量 = **锚点屏幕下推量**（`getBoundingClientRect().top` 差值，封顶 `FOLLOW_SETTLE_PAD_CAP_PX`=144）；宿主已自行补偿的动作（如审计台架的 fold 补偿）测得 0，不重复补偿；
- pad 退休段：级联静默（240ms）且排空结束后，0.45px/ms 把 pad 还给布局，视口平滑下滑到自然位置。

**实验室实测**（mock LLM，真实宿主，Layout Instability API 绘制级判据）：每次完成 1~2 次 layout-shift，值 ≈0.011~0.012（≈8px），sources 同时含引擎元素（`div.I17U7q_follow`）与宿主 chrome（`unmL2W_trailing`、`hvvBTq_headerActions`）；约 1/3 运行完全为零。回归闸门全绿：verify-y-rebound 5/5、run-render-audit 5/5、203 单测、tailbob、overflow、流式 painted Δv p95=0.0133（基线 0.015）。

## 五、尚未解决的残余（用户仍在真实环境看到抖动）

**残余现象**：用户真实环境（真实模型流、真实会话）中完成时刻仍有抖动；我的 mock 实验室只能复现 ~8px 级别，无法完全复现用户所见幅度。

**已知/怀疑的机制（按可疑度排序）**：

1. **双控制器竞争窗口**：宿主 ChatView 的 `toBottom`（layout effect，绘制前）在级联提交把视口钉到**塌缩后的 extent**，而引擎的 settle 守卫跑在 rAF（晚于宿主 effect）→ 宿主那一帧先画出下沉。已把守卫前置到 `restoreBeforePaint`（RO 路径），但**并非所有级联提交都会触发 RO/notifyFollowCommit**（如 turn-process 行挂载在 assistant 上方时，被观察的 tail 表面不改变尺寸）→ 存在漏捕获的提交。
2. **宿主锚点系统的种子效应**：一次 at-bottom 误判（floor − st > 25 的单帧）就会让宿主保存锚点（`chatScroll.save` / `anchorRef`），此后宿主的恢复路径反复把 scrollTop 拉回旧锚点，与引擎的 floor 钉制形成振荡（日志曾见 `external-scroll {from:16,to:52,ledger:52}` ×5——引擎每次钉 52，总有东西拉回 16）。
3. **live→settled 交换的行内重排**：settled 解析与 live 揭示的 markdown 几何不完全一致（行内回流，layout-shift sources 含 follow root 自身）——滚动层无法补偿，需揭示侧保证交换前后几何一致。
4. **宿主 chrome 的同窗重排**：composer/header 的重排不属于滚动引擎管辖。

## 六、诊断工具（已就位）

- **`[dsh-follow]` console 日志**：完成窗口自动武装（任何 finish 路径 15s 窗口），事件：`finish-enter` / `fast-gate` / `cleanup-dead-margin` / `host-rows`（逐帧 flow 子元素高度差）/ `anchor-push` / `settle`（状态变化帧）/ `retire-start` / `finish` / `external-scroll`（在 setFollowScrollTop 检测到非引擎滚动写入：宿主硬钉/浏览器钳制的直接证据）。
- `scripts/probe-host-completion.mjs <url>`：端到端（选 mock-stream 模型 → 发送 → 帧采样 + layout-shift PO + scrollTop 间谍 + 引擎日志捕获）。
- `scripts/probe-host-multiturn.mjs`：多轮（pad 回收路径）。
- `scripts/mock-llm-server.mjs`：本地 OpenAI 兼容 SSE mock（reasoning_content 触发 Think 块）；需在 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers` 下临时加 `dsh-mock` provider（apiKeyEnv: DSH_MOCK_KEY，baseURL: http://127.0.0.1:49731/v1），用 `DSH_MOCK_KEY=mock` 启动宿主；**测完删掉**（宿主会把 settings 重写回它的内存态）。
- `scripts/verify-y-rebound.mjs`（Y 轴零回弹闸门，glide-aware）、`scripts/run-render-audit.mjs`（5 画像完成链审计）、`scripts/check-lib-fresh.mjs`（lib 陈旧检测）。
- 页面内 scrollTop 间谍（probe 内置）：拦截属性写入带调用栈；**注意 `element.scrollTo()` 不走该 setter**（已在间谍中单独包装）。

## 七、硬性约束（修复不得破坏）

1. 流式期间：会话内容**零向下位移**（verify-y-rebound，容差 0.35px，glide-aware 豁免：extent 逐帧递减且步长 ≤10px 的限速归位不算违规）。
2. 完成态：**不残留引擎空间**（文本必须自然紧贴 composer；flow pad 终值必须为 0）。
3. 流式丝滑：painted Δv p95 ≤ 0.015 px/ms（`scripts/probe-velocity.mjs`）。
4. 弹簧参数不可动：`FOLLOW_SPRING_STIFFNESS=130 / DAMPING=24 / MASS=1 / SUBSTEPS=4`。
5. 全部闸门保持绿：rebound 5/5、run-render-audit 5/5、203 单测、tailbob、overflow 2/2。

## 八、给接手者的建议方向

1. **用 `[dsh-follow]` 日志在用户真实环境抓一次完整完成窗口**（用户已同意复制 console 输出）——重点看 `external-scroll` 与 `anchor-push` 的交错时序，确认残余抖动是"宿主 toBottom 钉到塌缩 extent"还是"锚点恢复路径"还是"settled 交换行内重排"。
2. 若是 (1)：考虑让引擎在**提交落 DOM 的同一任务**（layout effect 或 notifyFollowCommit）覆盖所有级联提交的 pre-paint 纠正——现状只覆盖触发 RO/notifyFollowCommit 的提交；或与宿主协商：ChatView 的 `toBottom` 在 `data-follow-owned` 存在时跳过（插件已导出 `hasRecentConversationFollow`）。
3. 若是 (2)：排查 at-bottom 误判的种子帧（溢出开始时 margin 一次性物化的 +72 帧）；宿主侧修复 = 恢复路径检查 `hasRecentConversationFollow`。
4. 若是 (3)：在揭示引擎侧让 settled 解析与 live 揭示的末态几何一致，或在交换时由插件测量 `swapDelta` 并做等量 extent 补偿。
5. 修改后必跑：`pnpm build` → **完全重启宿主**（bundle rev 启动时固化，只刷新页面无效）→ `node scripts/check-lib-fresh.mjs` → 全套闸门。
