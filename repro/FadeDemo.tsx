/** Standalone paint QA: real reveal/fade hooks, synthetic rich-text fixtures. */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { useSmoothStreamContent } from '../src/client/useSmoothStreamContent.ts'
import { fadeTailSize, useLogarithmicFade } from '../src/client/useLogarithmicFade.ts'
import css from './FadeDemo.module.css'

const ANSWER = '每一个新字符，先轻轻出现，再逐渐清晰。新的对数曲线让文字在前段保持通透，随后逐渐变实。\n\n网络短暂停顿时，末尾也会恢复正常亮度。重新收到内容后，旧字保持清晰，新字继续淡入。中文、English、é 和 👩‍👩‍👧‍👦 都保持完整。\n\n换行不会改变文字排版，选择与复制仍然使用原来的文本。'.repeat(3)
const THOUGHT = '先观察输入节奏，再检查渲染后的文本范围。随输出速度调整尾部范围，保留已经出现字符的动画进度。\n\n思考与回答共享同一个逐帧调度，在网络停顿后都能自然恢复清晰。'.repeat(4)

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const ANSWER_CHARS = [...segmenter.segment(ANSWER)].map(part => part.segment)
const THOUGHT_CHARS = [...segmenter.segment(THOUGHT)].map(part => part.segment)

/** Sample actual painted ranges without making the text fixtures re-render. */
function FadeMetrics({ rootRef }: { rootRef: RefObject<HTMLElement | null> }) {
  const [stats, setStats] = useState([{ active: 0, window: 24 }, { active: 0, window: 24 }])
  useEffect(() => {
    const sample = () => {
      const roots = ['thinking', 'answer'].map(kind => rootRef.current?.querySelector<HTMLElement>(`[data-fade-fixture="${kind}"]`))
      const next = roots.map(root => ({ active: 0, window: Number(root?.dataset.fadeWindow ?? 24) }))
      if (typeof CSS !== 'undefined' && CSS.highlights) {
        for (const [name, highlight] of CSS.highlights) {
          if (!name.includes('dsh-smooth-stream-log-fade-')) continue
          for (const range of highlight) {
            roots.forEach((root, index) => {
              if (root?.contains(range.startContainer)) next[index]!.active += 1
            })
          }
        }
      }
      setStats(previous => previous.every((value, index) => value.active === next[index]!.active && value.window === next[index]!.window) ? previous : next)
    }
    sample()
    const timer = setInterval(sample, 100)
    return () => { clearInterval(timer) }
  }, [rootRef])
  return (
    <div className={css.metrics} aria-label="实时字素监测">
      {stats.map((stat, index) => (
        <div key={index}>
          <span>{index === 0 ? '思考' : '正文'}淡入中 </span>
          <strong data-fade-count={index === 0 ? 'thinking' : 'answer'}>{stat.active}</strong>
          <span> 字素 · 速度窗口 {stat.window}</span>
        </div>
      ))}
      <span className={css.metricHint}>每 100ms 更新 · 暂停时冻结透明度</span>
    </div>
  )
}

function TextFixture({ text, streaming, enabled, interrupted, paused, kind, thinking = false }: {
  text: string
  streaming: boolean
  enabled: boolean
  interrupted: boolean
  paused: boolean
  kind: string
  thinking?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const speedCpsRef = useRef(35)
  const shown = useSmoothStreamContent(text, { enabled: !interrupted, inputComplete: !streaming, speedCpsRef })
  useLogarithmicFade(ref, enabled && !interrupted, streaming || shown !== text, speedCpsRef, paused)
  return (
    <div ref={ref} className={thinking ? css.thinking : css.answer} data-fade-fixture={thinking ? 'thinking' : 'answer'} data-fade-window={fadeTailSize(speedCpsRef.current)} data-shown={shown.length} data-target={text.length}>
      {kind === 'code' ? <pre><code>{shown}</code></pre>
        : kind === 'formula' ? <span className="katex">{shown}</span>
          : shown.split('\n\n').map((line, i) => <p key={i}>{i === 1 ? <strong>{line}</strong> : line}</p>)}
    </div>
  )
}

export function FadeDemo() {
  const pageRef = useRef<HTMLElement>(null)
  const [count, setCount] = useState(0)
  const [running, setRunning] = useState(false)
  const [paused, setPaused] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [reduced, setReduced] = useState(false)
  const [dark, setDark] = useState(false)
  const [interrupted, setInterrupted] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [speed, setSpeed] = useState(50)
  const inputSpeedRef = useRef(50)
  const [kind, setKind] = useState('prose')
  useEffect(() => {
    if (!running || paused) return
    let previous = performance.now()
    let debt = 0
    const timer = setInterval(() => {
      const now = performance.now()
      debt += (now - previous) * inputSpeedRef.current / 1000
      previous = now
      const amount = Math.floor(debt)
      debt -= amount
      if (amount > 0) setCount(value => Math.min(ANSWER_CHARS.length, value + amount))
    }, 40)
    return () => { clearInterval(timer) }
  }, [running, paused, generation])
  useEffect(() => { if (count === ANSWER_CHARS.length) setRunning(false) }, [count])
  return (
    <main ref={pageRef} className={css.page} data-dark={dark || undefined}>
      <header className={css.header}>
        <p className={css.eyebrow}>SMOOTH STREAM / LOCAL PREVIEW</p>
        <h1>让新文字，自然清晰。</h1>
        <p>对数淡入 · 240ms · 24–160 字素随速度变化</p>
        <FadeMetrics rootRef={pageRef} />
        <div className={css.controls}>
          <button onClick={() => { setGeneration(v => v + 1); setCount(0); setRunning(true); setPaused(false); setInterrupted(false) }}>重新生成</button>
          <button disabled={!running || paused} onClick={() => { setPaused(true) }}>暂停</button>
          <button disabled={!running || !paused} onClick={() => { setPaused(false) }}>播放</button>
          <button disabled={!running} onClick={() => { setRunning(false); setInterrupted(true) }}>停止</button>
          <label><input type="checkbox" checked={enabled} onChange={e => { setEnabled(e.target.checked) }} />对数淡入</label>
          <label><input type="checkbox" checked={dark} onChange={e => { setDark(e.target.checked) }} />深色</label>
          <label><input type="checkbox" checked={reduced} onChange={e => { setReduced(e.target.checked) }} />减少动画</label>
          <label className={css.speed}>
            <span>输出速度 <output>{speed} 字/秒</output></span>
            <input
              type="range"
              aria-label="输出速度"
              aria-valuetext={`${speed} 字/秒`}
              min={1}
              max={1000}
              step={1}
              value={speed}
              onChange={e => { const value = Number(e.target.value); inputSpeedRef.current = value; setSpeed(value) }}
            />
          </label>
          <select aria-label="文本类型" value={kind} onChange={e => { setKind(e.target.value) }}><option value="prose">正文</option><option value="code">代码保护</option><option value="formula">公式保护</option></select>
        </div>
        <p className={css.speedHint}>拖动滑块可实时调速（1–1000 字/秒）。控制模拟输入速度，文字经平滑队列显示。</p>
        <p role="status">{interrupted ? '已停止' : paused ? '已暂停，当前透明度已冻结' : running ? '正在播放' : count ? '已完成' : '点击重新生成，开始预览'}</p>
      </header>
      <div className={css.columns} key={generation}>
        <section><h2>思考过程</h2><TextFixture thinking text={THOUGHT_CHARS.slice(0, count).join('')} streaming={running} enabled={enabled && !reduced} interrupted={interrupted || reduced} paused={paused} kind={kind} /></section>
        <section><h2>回答正文</h2><TextFixture text={ANSWER_CHARS.slice(0, count).join('')} streaming={running} enabled={enabled && !reduced} interrupted={interrupted || reduced} paused={paused} kind={kind} /></section>
      </div>
      <footer>复用真实逐字输出与淡入引擎；富文本为本地测试样例，非运行中的 Harness 会话。</footer>
    </main>
  )
}
