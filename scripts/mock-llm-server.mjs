#!/usr/bin/env node
/** One-off: local OpenAI-completions-compatible streaming mock for host E2E. */
import { createServer } from 'node:http'

const REASONING = Array.from({ length: 6 }, (_, i) =>
  `第${i + 1}步：用户希望我详细介绍主题，我需要组织一个多段落的长回复，涵盖背景、原理、挑战与展望，并保持每段长度足够触发折行。`).join('\n')

const BODY = Array.from({ length: 14 }, (_, i) =>
  `第${i + 1}段：流式渲染引擎把字符揭示、弹簧动力学与合成器位移解耦成三层，字符揭示按时间比例积分推进，弹簧以恒定参数收敛几何目标，合成器位移负责把每一帧的残差画成连续的视觉运动，从而在换行、断流与收尾三种扰动下都保持视线锚点静止。这一段刻意写得很长，用来触发多次整行折行，检验滚动跟随是否平滑，同时也让收尾阶段有足够的排水量可以观察归位动画的细节表现。`).join('\n\n')

let first = true
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const write = (obj) => { res.write(`data: ${JSON.stringify(obj)}\n\n`) }
      const chunk = (content, reasoning) => write({
        id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock-stream',
        choices: [{ index: 0, delta: { ...(reasoning ? { reasoning_content: reasoning } : {}), ...(content ? { content } : {}) }, finish_reason: null }],
      })
      let i = 0
      const total = REASONING.length + BODY.length
      const step = 8
      const pump = () => {
        if (i < REASONING.length) { chunk(null, REASONING.slice(i, i + step)); i += step }
        else if (i < total) { chunk(BODY.slice(i - REASONING.length, i - REASONING.length + step)); i += step }
        else {
          write({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock-stream', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 2600, total_tokens: 2700 } })
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        setTimeout(pump, 25)
      }
      pump()
      first = false
    })
    return
  }
  if (req.url?.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-stream' }] }))
    return
  }
  res.writeHead(404); res.end()
})
server.listen(49731, '127.0.0.1', () => console.log('mock llm on http://127.0.0.1:49731/v1'))
