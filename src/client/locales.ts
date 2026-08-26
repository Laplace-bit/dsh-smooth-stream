/** Locale bundles for the smooth-stream plugin configuration card. */

/** Dictionary namespace owned by this plugin's settings card. */
export const NS = 'settings.smoothStream'

/** Locale keys the card renders. */
export type SmoothStreamLocaleKey =
  | 'title' | 'description'
  | 'enabled' | 'enabledHint'
  | 'thinkAutoExpand' | 'thinkAutoExpandHint'
  | 'autoCollapse' | 'autoCollapseHint'
  | 'debugEnabled' | 'debugEnabledHint' | 'debugUnavailable'
  | 'debugPanelTitle' | 'debugPanelToggle' | 'debugPanelClose' | 'debugGuide'
  | 'debugLive' | 'debugIdle' | 'debugUnsaved'
  | 'debugSave' | 'debugDiscard' | 'debugReset' | 'debugCopy' | 'debugCopied'
  | 'debugSectionLive' | 'debugSectionReveal' | 'debugSectionFollow'
  | 'debugFps' | 'debugFrameTime' | 'debugBacklog' | 'debugRevealSpeed' | 'debugProgress'
  | 'debugFollowState' | 'debugFollowing' | 'debugReleased'
  | 'debugLag' | 'debugVelocity' | 'debugReserve' | 'debugCapacity' | 'debugAppliedScale'
  | 'debugRevealMultiplier' | 'debugQueuePressure' | 'debugMaxReveal'
  | 'debugSpringStiffness' | 'debugSpringDamping' | 'debugSpringMass'
  | 'debugRunway' | 'debugReserveResponse' | 'debugBackpressureMin'
  | 'debugTipRevealMultiplier' | 'debugTipQueuePressure' | 'debugTipMaxReveal'
  | 'debugTipSpringStiffness' | 'debugTipSpringDamping' | 'debugTipSpringMass'
  | 'debugTipRunway' | 'debugTipReserveResponse' | 'debugTipBackpressureMin'
  | 'readOnly' | 'loading' | 'unavailable' | 'retry'
  | 'version' | 'developmentVersion'
  | 'updates' | 'updateHint' | 'developmentBuild' | 'updateUnavailable'
  | 'update' | 'updating' | 'restartRequired' | 'updateFailed'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed'

/** English copy. */
export const en: Record<SmoothStreamLocaleKey, string> = {
  title: 'Smooth stream',
  description: 'How replies are revealed while they stream.',
  enabled: 'Enable smooth streaming',
  enabledHint: 'Let this plugin render and follow streaming replies. Turn off to use the built-in Harness renderer.',
  thinkAutoExpand: 'Auto-expand thinking',
  thinkAutoExpandHint: 'Open the thinking block while it streams. Turn off to keep it collapsed.',
  autoCollapse: 'Collapse finished work',
  autoCollapseHint: 'When a reply finishes, fold its thinking, tools, and intermediate output behind one “Processed” summary so only the final answer shows. Click the summary to expand again; works with streaming on or off.',
  debugEnabled: 'Show render diagnostics',
  debugEnabledHint: 'Show live streaming and scroll metrics on the right side of the chat. Tune values there, then save them here.',
  debugUnavailable: 'Live diagnostics require a newer plugin Host.',
  debugPanelTitle: 'Render diagnostics',
  debugPanelToggle: 'Toggle render diagnostics',
  debugPanelClose: 'Hide diagnostics panel',
  debugGuide: 'Tune one value at a time while a reply streams. Keep FPS stable and backlog near zero. If text lags, raise the reveal multiplier, queue pressure, or maximum reveal; if a blank gap appears, reduce Predictive runway. Increase damping when the scroll feels springy. Save only after the behavior is stable; Reset restores the production defaults.',
  debugLive: 'Streaming',
  debugIdle: 'Idle',
  debugUnsaved: 'Unsaved tuning',
  debugSave: 'Save tuning',
  debugDiscard: 'Discard changes',
  debugReset: 'Reset tuning',
  debugCopy: 'Copy diagnostics',
  debugCopied: 'Copied',
  debugSectionLive: 'Live renderer',
  debugSectionReveal: 'Reveal tuning',
  debugSectionFollow: 'Scroll tuning',
  debugFps: 'FPS',
  debugFrameTime: 'Frame',
  debugBacklog: 'Backlog',
  debugRevealSpeed: 'Reveal',
  debugProgress: 'Progress',
  debugFollowState: 'Follow',
  debugFollowing: 'Pinned',
  debugReleased: 'Released',
  debugLag: 'Visual lag',
  debugVelocity: 'Velocity',
  debugReserve: 'Reserve',
  debugCapacity: 'Capacity',
  debugAppliedScale: 'Applied scale',
  debugRevealMultiplier: 'Reveal multiplier',
  debugQueuePressure: 'Queue pressure',
  debugMaxReveal: 'Maximum reveal',
  debugSpringStiffness: 'Spring stiffness',
  debugSpringDamping: 'Spring damping',
  debugSpringMass: 'Spring mass',
  debugRunway: 'Predictive runway',
  debugReserveResponse: 'Runway response',
  debugBackpressureMin: 'Minimum backpressure',
  debugTipRevealMultiplier: 'Overall reveal speed multiplier. Higher reveals text faster and clears backlog sooner, but can feel jumpy. Lower is smoother but takes longer to finish.',
  debugTipQueuePressure: 'Backlog acceleration strength. Higher catches up to a growing queue more aggressively; lower keeps speed steadier but may leave backlog.',
  debugTipMaxReveal: 'Hard cap for reveal speed in characters per second. Higher allows faster catch-up; lower limits bursts and keeps motion calmer.',
  debugTipSpringStiffness: 'Scroll spring strength. Higher closes visual lag faster but can feel sharp; lower feels softer but follows more slowly.',
  debugTipSpringDamping: 'Scroll energy damping. Higher suppresses overshoot and jitter but feels heavier; lower feels livelier but may oscillate.',
  debugTipSpringMass: 'Scroll inertia. Higher makes movement slower and heavier; lower makes it react faster but can feel abrupt.',
  debugTipRunway: 'Predictive blank space reserved while content grows. Higher absorbs growth and protects the bottom follow, but can create a larger visible gap; lower reduces blank space but leaves less room to absorb lag.',
  debugTipReserveResponse: 'How quickly the reserved runway opens or closes. Higher changes more gradually; lower reacts faster but can look abrupt.',
  debugTipBackpressureMin: 'Slowest reveal multiplier under scroll pressure. Higher keeps text moving but may increase visual lag; lower slows text more to protect smooth following.',
  readOnly: 'This deployment stores settings read-only.',
  loading: 'Loading plugin settings…',
  unavailable: 'Plugin settings are unavailable in this connection.',
  retry: 'Retry',
  version: 'Version {version}',
  developmentVersion: 'Development version {version}',
  updates: 'Updates',
  updateHint: 'Install the newest npm version, then restart Harness.',
  developmentBuild: 'Linked source; updates are managed in the checkout.',
  updateUnavailable: 'Updates are available only for an npm profile installation.',
  update: 'Update',
  updating: 'Updating…',
  restartRequired: 'Updated. Restart Harness to load the new version.',
  updateFailed: 'The package update failed; your current version is unchanged.',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
}

/** Simplified Chinese copy. */
export const zh: Record<SmoothStreamLocaleKey, string> = {
  title: '丝滑流式',
  description: '回复在流式输出时如何逐字展现。',
  enabled: '启用丝滑流式渲染',
  enabledHint: '由本插件渲染并跟随流式回复；关闭后使用 Harness 内置渲染。',
  thinkAutoExpand: '自动展开思考',
  thinkAutoExpandHint: '思考块在流式时自动展开；关闭后保持折叠，可手动展开。',
  autoCollapse: '完成后自动折叠',
  autoCollapseHint: '回复处理完成后，把思考、工具与过程输出折叠为一行“已处理”摘要，只展示最终回复；点击摘要可再次展开。开启或关闭流式渲染均可用，默认开启。',
  debugEnabled: '显示渲染调试面板',
  debugEnabledHint: '在聊天右侧显示流式渲染和滚动的实时参数，可在面板中调节并在这里保存。',
  debugUnavailable: '当前 Host 版本不支持实时调试，请先更新插件 Host。',
  debugPanelTitle: '渲染诊断',
  debugPanelToggle: '显示或隐藏渲染诊断',
  debugPanelClose: '收起诊断面板',
  debugGuide: '流式输出时一次只调一个参数，观察帧率、积压和视觉滞后。优先保持帧率稳定、积压接近 0；如果文字滞后，提高揭示倍率、队列压力或最大揭示速度；如果底部出现空白，降低“预测预留空间”。滚动有回弹或抖动时提高阻尼。确认表现稳定后再保存；“恢复默认参数”会回到生产默认值。',
  debugLive: '正在流式输出',
  debugIdle: '空闲',
  debugUnsaved: '参数尚未保存',
  debugSave: '保存参数',
  debugDiscard: '放弃修改',
  debugReset: '恢复默认参数',
  debugCopy: '复制诊断数据',
  debugCopied: '已复制',
  debugSectionLive: '实时渲染',
  debugSectionReveal: '流式参数',
  debugSectionFollow: '滚动参数',
  debugFps: '帧率',
  debugFrameTime: '帧耗时',
  debugBacklog: '积压字符',
  debugRevealSpeed: '揭示速度',
  debugProgress: '渲染进度',
  debugFollowState: '跟随状态',
  debugFollowing: '跟随底部',
  debugReleased: '用户已释放',
  debugLag: '视觉滞后',
  debugVelocity: '滚动速度',
  debugReserve: '预留空间',
  debugCapacity: '安全容量',
  debugAppliedScale: '实际倍率',
  debugRevealMultiplier: '揭示倍率',
  debugQueuePressure: '队列压力',
  debugMaxReveal: '最大揭示速度',
  debugSpringStiffness: '弹簧刚度',
  debugSpringDamping: '弹簧阻尼',
  debugSpringMass: '弹簧质量',
  debugRunway: '预测预留空间',
  debugReserveResponse: '预留响应时间',
  debugBackpressureMin: '最小背压倍率',
  debugTipRevealMultiplier: '整体文字揭示速度倍率。调大能更快清空积压，但可能显得跳；调小更平滑，但完成回复需要更久。',
  debugTipQueuePressure: '积压对加速的影响强度。调大能更积极追赶增长中的队列；调小速度更稳定，但积压可能持续。',
  debugTipMaxReveal: '每秒揭示字符数上限。调大允许更快追赶；调小限制突发速度，让动作更平稳。',
  debugTipSpringStiffness: '滚动弹簧刚度。调大更快收拢视觉滞后，但感觉更硬；调小更柔和，但跟随更慢。',
  debugTipSpringDamping: '滚动能量阻尼。调大能抑制过冲和抖动，但感觉更沉；调小更灵活，但可能回弹。',
  debugTipSpringMass: '滚动惯性。调大移动更慢更沉；调小反应更快，但可能显得突兀。',
  debugTipRunway: '内容增长时预留的预测空白。调大更能吸收增长、保护底部跟随，但可能产生更大的可见空区；调小能减少空白，但可吸收滞后的空间也更少。',
  debugTipReserveResponse: '预留空间打开或关闭的响应时间。调大变化更渐进；调小反应更快，但可能显得突变。',
  debugTipBackpressureMin: '滚动压力下允许的最低揭示倍率。调大文字仍会较快前进，但视觉滞后可能增加；调小会更积极减速，以保护跟随平滑。',
  readOnly: '本部署的设置为只读。',
  loading: '正在加载插件设置…',
  unavailable: '当前连接无法访问插件设置。',
  retry: '重试',
  version: '版本 {version}',
  developmentVersion: '开发版本 {version}',
  updates: '更新',
  updateHint: '安装最新 npm 版本后重启 Harness。',
  developmentBuild: '当前为本地链接版本，请在源码目录管理更新。',
  updateUnavailable: '只有 profile 使用 npm 包时才能更新。',
  update: '更新',
  updating: '更新中…',
  restartRequired: '已更新；重启 Harness 后加载新版本。',
  updateFailed: '包更新失败，当前版本未改变。',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.smoothStream': SmoothStreamLocaleKey
  }
}
