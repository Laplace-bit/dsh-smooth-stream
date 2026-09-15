import { cleanup, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { createElement, type FunctionComponent } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => { cleanup() })

function assistantProps(t: (key: string) => string): Record<string, unknown> {
  return {
    node: {
      kind: 'assistant-step',
      location: { kind: 'unresolved' },
      data: {
        status: 'running',
        blocks: [{ kind: 'reasoning', text: 'latest tokens' }],
        turn: 1,
        step: 1,
        time: 0,
      },
    },
    loadImage: async () => new Blob(),
    useTurnData: () => undefined,
    openFile: () => {},
    fileMentions: () => undefined,
    t,
  }
}

async function localeBench(options: { chatThink?: string } = {}): Promise<{
  ctx: Context
  locale: LocaleRuntime
  component: FunctionComponent<Record<string, unknown>>
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
  } as never, () => null)

  const locale = new LocaleRuntime(ctx)
  locale.register('conversation', {
    zh: { 'image.label': '图片', 'row.running': '正在生成' },
    en: { 'image.label': 'Image', 'row.running': 'Generating' },
  } as never)
  if (options.chatThink !== undefined) {
    const loose = locale as unknown as {
      register(ns: string, dicts: Record<string, Record<string, string>>): () => void
    }
    loose.register('chat', {
      zh: { 'message.think': options.chatThink },
      en: { 'message.think': 'Thinking' },
    })
  }
  locale.setLocale('zh')
  ctx.provide('locale', locale)

  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const entry = slots.entries('conversation.chat.node')
    .find(item => item.options.key === 'assistant-step' && item.options.priority === -100)
  if (entry === undefined) throw new Error('assistant renderer was not registered')
  return {
    ctx,
    locale,
    component: entry.component as FunctionComponent<Record<string, unknown>>,
    dispose: () => fiber.dispose(),
  }
}

function conversationT(locale: LocaleRuntime): (key: string) => string {
  return locale.bind('conversation') as unknown as (key: string) => string
}

describe('assistant renderer locale routing', () => {
  it('localizes the Think title when the optional Connection is absent', async () => {
    const { locale, component, dispose } = await localeBench()
    const view = render(createElement(component, assistantProps(conversationT(locale))))

    expect(view.getByText('思考')).toBeTruthy()
    expect(view.getByText('正在生成')).toBeTruthy()
    expect(view.container.textContent).not.toContain('message.think')
    await dispose()
  })

  it('prefers a Harness chat translation over the plugin fallback', async () => {
    const { locale, component, dispose } = await localeBench({ chatThink: '来自 Chat 的思考' })
    const view = render(createElement(component, assistantProps(conversationT(locale))))

    expect(view.getByText('来自 Chat 的思考')).toBeTruthy()
    await dispose()
  })

  it('keeps the Think fallback after Connection disconnects', async () => {
    const { ctx, locale, component, dispose } = await localeBench()
    const removeConnection = ctx.provide('connection', {
      rpc: { call: () => new Promise(() => {}) },
    } as never)
    const props = assistantProps(conversationT(locale))
    const view = render(createElement(component, props))
    expect(view.getByText('思考')).toBeTruthy()

    removeConnection()
    view.rerender(createElement(component, props))

    expect(view.getByText('思考')).toBeTruthy()
    expect(view.container.textContent).not.toContain('message.think')
    await dispose()
  })
})
