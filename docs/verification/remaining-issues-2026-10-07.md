# 剩余 PR 与 issue 验证记录

日期：2026-10-07。整合 PR #35、#40。发布候选版本：0.8.0-rc.1。

## 已完成的修复与验证

- 保留 #39 的助手组件原地替换、按 groupPart 分流、response 行统一拥有滚动端口和回答开始时折叠 Think 的逻辑。
- 用真实 Cordis / SlotRegistry 验证动态 Agent 注册、启停和卸载。修复 fallback 注册监听递归重入；卸载先停止监听，再恢复组件原引用。
- 现代设置字段使用 volatile 配置；读取解包运行时 Volatile，写入通过 settings.update 并携带当前 revision。移除绕过校验的 profile editor 回退。
- 使用 Harness 的真实配置服务验证保存、profile 文件写入、重启恢复、陈旧 revision 拒绝、普通非 volatile 字段写入拒绝。
- 在独立安装、完整构建的 Harness 0.1.7-rc.2（3a83e7e472）和 0.2.0-rc.2（639ed01539）运行真实 Chrome：从侧栏插件详情打开设置，修改并保存，刷新后仍生效；流式 Think 自动展开，回答开始时折叠；禁用自动展开后保持折叠。两代均无 page/console error。
- 配置页注册在第三方 bundle 使用的 plugins.bundle.config；旧 settings.plugin.item 路径保留。不得将第三方插件放进 plugins.item 官方列表。
- 采用现代配置投影的 Harness（0.1.7 起）默认交给原生滚动，可通过设置开启接管；旧 settings 注册表保持默认开启。这是能力分支，不能描述为所有 0.1.x 都默认开启。
- 修复通用 Agent 文本队列排空后 task 未注销、后续 DOM 内容无法唤醒的问题；已有复现测试由失败转为通过。
- FPS 可见性观察器不再每次渲染重建，补上 React 18 StrictMode effect replay 的重连及卸载测试。
- 跑道清理仅匹配已知 48/72px 旧残留，保留宿主 12px、calc(2rem + 12px)、相对边距；恢复仍由当前实例拥有的原始边距。
- #34：含行内代码或替换元素的段落不再应用 text-box-trim。生产 CSS 在 Chrome 154、DPR 1.25 下验证长行内代码分成 7 行、段落 trim=none、中文前后缀存在、下一段无重叠。保留 inline 换行行为。

## 验证命令与边界

- typecheck、build、check-lib-fresh：通过。
- 构建产物设置卡 SSR：8/8 通过。
- 真实 Harness 配置服务集成：1/1 通过。
- 完整 Vitest：275 通过、8 失败。对照 main 5f82313 在相同测试基础设施下为 221 通过、30 失败；剩余 8 项均在 main 对照中失败。没有把全量结果记为通过。
- 一些旧断言已更新：preset 写入字段、motion radio 的作用域、助手原地替换、Volatile 解包、observer 微任务和共享帧时基。
- 剩余滚动用例涉及固定 viewport rect 与变化 scrollHeight 的不一致夹具、移除后的 status margin、真实高度 clamp 和终态 floor。已保留失败；尚不足以证明全部无害，也没有为消除失败而放宽界限或跳过测试。它们是候选版后续验证项。
- #25 Windows 文字重影未在同平台复现；#34 的 Windows 中文绘制丢失也未在 macOS 复现。Chrome 布局测试不等于 Windows GPU 绘制验证，这两个 issue 保留待回归。
- peer 范围从此候选版起面向 Harness 0.1.7-rc.1 与 0.2.0 预发布线；更旧内核的兼容分支保留，但不再属于声明的支持范围。

### 尚未通过的完整测试

- assistant renderer caps a dropped RAF interval so the first recovery paint does not teleport
- assistant renderer keeps the text-to-status gap natural after the reader returns to the floor
- assistant renderer never drains past the natural final position before removing its runway
- assistant renderer measures transform clearance from the real floor before splitting lag
- isGrowingChatNode eases the newly inserted 'context row in an open step' from the pre-insert extent
- isGrowingChatNode eases the newly inserted 'first running Tool row' from the pre-insert extent
- isGrowingChatNode uses all safe paint room to soften the final 'tool result' height
- isGrowingChatNode uses all safe paint room to soften the final 'command result' height
