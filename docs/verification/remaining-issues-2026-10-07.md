# 8 项历史测试失败的处理记录

日期：2026-10-30。历史清单最初记录于 2026-10-07，PR #46 合入后的基线为 `304f900`。

基线完整 Vitest 为 305 通过、8 失败。修正后为 315/315，其中流式测试文件 `tests/stream.client.spec.tsx` 为 160/160。
没有跳过用例，也没有增加原有位移容差；下表区分实现缺陷与夹具、旧预期的问题。

## 原因与处理

| 历史用例 | 原因与处理 |
| --- | --- |
| dropped RAF interval | 手动帧夹具漏掉共享时钟的初始化帧，且仍按旧弹簧路径计算期望。先完成初始化，再模拟 100ms 掉帧，核对当前预测轨迹只推进 32ms。 |
| text-to-status gap after return | 预测轨迹没有服从实时的内容增长开关，返回底部后还沿用旧轨迹。统一采用实时开关，并在重新跟随时清除旧轨迹位置。 |
| natural final position | 夹具仍计入已移除 status 的边距，并把移除等量边距和 transform 时的原始 scrollTop 变化误当成回弹。改为只计在场元素，测量实际可见位置；1px 容差保留。 |
| transform clearance from real floor | 在旧 scrollTop 测量可用空间会错误压掉变换。先写实际底部，再测量；底部变化时使几何缓存失效。 |
| context row entrance | 首个共享帧只初始化时基；测量新插入行需推进到第二帧。原有位移与收敛断言保留。 |
| first running Tool entrance | 同上。 |
| final tool result height | 最终高度增长被直接吸附到底部的收尾分支吞掉。对已测得新增高度的通用行保留一次缓动收尾。 |
| final command result height | 同上。 |

<a id="尚未通过的完整测试"></a>

## 历史失败清单

以下保留原始用例名，8 项现已全部通过。上面的锚点兼容已有验证记录中的链接。

- assistant renderer caps a dropped RAF interval so the first recovery paint does not teleport
- assistant renderer keeps the text-to-status gap natural after the reader returns to the floor
- assistant renderer never drains past the natural final position before removing its runway
- assistant renderer measures transform clearance from the real floor before splitting lag
- isGrowingChatNode eases the newly inserted 'context row in an open step' from the pre-insert extent
- isGrowingChatNode eases the newly inserted 'first running Tool row' from the pre-insert extent
- isGrowingChatNode uses all safe paint room to soften the final 'tool result' height
- isGrowingChatNode uses all safe paint room to soften the final 'command result' height

## 验证

环境：Node.js 26.12.1、pnpm 11.23.0、Vitest 4.1.10；测试引用相邻 Harness 源码 `ce7073d512`。

- `pnpm exec vitest run tests/stream.client.spec.tsx`：160/160。
- `pnpm test`：19 个测试文件、315/315。
- `pnpm typecheck`、`pnpm build`：通过。

动态位移结论来自确定性测试；本次没有新增真实模型对话，也未重跑完整浏览器流式审计。Windows GPU 绘制问题不在这 8 项测试的验证范围内。
