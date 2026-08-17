/** Locale bundles for the smooth-stream plugin configuration card. */

/** Dictionary namespace owned by this plugin's settings card. */
export const NS = 'settings.smoothStream'

/** Locale keys the card renders. */
export type SmoothStreamLocaleKey =
  | 'title' | 'description'
  | 'thinkAutoExpand' | 'thinkAutoExpandHint'
  | 'readOnly' | 'loading' | 'unavailable' | 'retry'
  | 'version' | 'developmentVersion'
  | 'updates' | 'updateHint' | 'developmentBuild' | 'updateUnavailable'
  | 'update' | 'updating' | 'restartRequired' | 'updateFailed'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed'

/** English copy. */
export const en: Record<SmoothStreamLocaleKey, string> = {
  title: 'Smooth stream',
  description: 'How replies are revealed while they stream.',
  thinkAutoExpand: 'Auto-expand thinking',
  thinkAutoExpandHint: 'Open the thinking block while it streams. Turn off to keep it collapsed.',
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
  thinkAutoExpand: '自动展开思考',
  thinkAutoExpandHint: '思考块在流式时自动展开；关闭后保持折叠，可手动展开。',
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
