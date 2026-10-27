/**
 * 折叠行为策略。
 *
 * 思考块的开合曾经用三个互不相关的布尔表达：自动展开、完成后保持、解除高度
 * 限制。每加一个行为，设置层就要复制一整条链路（类型、schema、RPC 校验、视图、
 * 客户端 API、卡片状态、界面、文案、渲染器）。这个模块把它们收敛成按阶段命名
 * 的状态：渲染器只问「此刻该开还是该关」，不再自己判断策略。
 *
 * 新增一类可折叠对象时，在这里加一个 policy 类型，设置层随之增加对应字段；
 * 渲染器只消费策略，不读原始设置。
 */

/** 一个阶段的默认开合。 */
export type FoldState = 'expanded' | 'collapsed'

/**
 * 展开正文的高度处理。
 * `limited` 让正文留在自身滚动框内，`full` 按完整高度铺开并交给会话滚动。
 */
export type FoldHeight = 'limited' | 'full'

/** 思考块的折叠行为。 */
export interface ThinkFoldPolicy {
  /** 流式生成期间：每一段思考开始输出时采用的开合。 */
  readonly running: FoldState
  /** 停止输出之后：running→settled 翻转时采用的开合。 */
  readonly settled: FoldState
  /** 展开后的正文高度。 */
  readonly height: FoldHeight
}

/** 可选开合，供设置界面与入参校验共用。 */
export const FOLD_STATES: readonly FoldState[] = ['expanded', 'collapsed']

/** 可选高度，供设置界面与入参校验共用。 */
export const FOLD_HEIGHTS: readonly FoldHeight[] = ['limited', 'full']

/** 与旧三个布尔的默认组合一致：流式展开、结束收起、限高。 */
export const DEFAULT_THINK_FOLD: ThinkFoldPolicy = {
  running: 'expanded',
  settled: 'collapsed',
  height: 'limited',
}

/**
 * 判断一个未知值是否为合法开合。
 * @param value - 待判断的值。
 * @returns 是否为 {@link FoldState}。
 */
export function isFoldState(value: unknown): value is FoldState {
  return value === 'expanded' || value === 'collapsed'
}

/**
 * 判断一个未知值是否为合法高度。
 * @param value - 待判断的值。
 * @returns 是否为 {@link FoldHeight}。
 */
export function isFoldHeight(value: unknown): value is FoldHeight {
  return value === 'limited' || value === 'full'
}

/**
 * 当前阶段应采用的开合。
 * @param policy - 思考块策略。
 * @param running - 该块是否仍在输出。
 * @returns 当前阶段的开合。
 */
export function foldStateFor(policy: ThinkFoldPolicy, running: boolean): FoldState {
  return running ? policy.running : policy.settled
}
