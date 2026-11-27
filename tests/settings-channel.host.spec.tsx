/**
 * Host half mounts its settings channel even when the kernel's own
 * `connection.rpc.handle()` cannot resolve `webServer` from inside that
 * service. The browser then reaches the card instead of reporting the
 * connection as unable to read plugin settings.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, ConnectionRpcHandlerOptions } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import * as DshSettings from '@deepseek-ai/dsh-settings'
const { SettingsProvider } = DshSettings
type SettingsNamespace = DshSettings.SettingsNamespace
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STREAM_PACKAGE_VERSION } from '../src/package-meta.ts'
import { apply, Config } from '../src/plugin.ts'
import { STREAM_SETTINGS_RPC, STREAM_SETTINGS_RPC_CHANNEL } from '../src/settings-api.ts'
import { DEFAULT_STREAM_SETTINGS, STREAM_SETTINGS_NS } from '../src/settings.ts'
import { registerSettingsChannel } from '../src/settings-channel.ts'

/** In-memory settings provider -- same shape as the Harness's own specs. */
class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

/** One recorded reply, so a route can be driven without a real socket. */
interface Exchange {
  status: number
  body: string
}

/** Web server stand-in that records routes and drops them on disposal. */
function fakeWebServer(routes: WebRoute[]): {
  register(route: WebRoute): () => void
  tapIndex(): () => void
} {
  return {
    register(route: WebRoute): () => void {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
    tapIndex(): () => void { return () => {} },
  }
}

/**
 * Mount the Host half over a connection service whose `rpc.handle()` fails the
 * way the broken kernel generation does.
 * @param fenced - whether the fake connection also exposes its request fence.
 */
async function mountHost(fenced: boolean): Promise<{ ctx: Context; routes: WebRoute[]; dispose: () => Promise<void> }> {
  const ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(process.cwd()).href}/`
  const routes: WebRoute[] = []
  ctx.provide('webServer', fakeWebServer(routes) as never)
  ctx.provide('connection', {
    rpc: {
      handle(_channel: string, _handler: ConnectionRpcHandler, _options: ConnectionRpcHandlerOptions): () => Promise<void> {
        throw new Error('cannot get property "webServer" without inject')
      },
    },
    ...fenced
      ? {
        requestRejection(request: unknown): 401 | undefined {
          return (request as IncomingMessage).headers.cookie === undefined ? 401 : undefined
        },
      }
      : {},
  } as never)
  await ctx.plugin(MemorySettings).await()
  const fiber = ctx.plugin({ apply, Config })
  await fiber.await()
  return { ctx, routes, dispose: () => fiber.dispose() }
}

const mounted: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of mounted.splice(0)) await dispose()
})

/** Drive one route with a request envelope and capture the reply. */
async function call(
  route: WebRoute,
  endpoint: string,
  payload: unknown,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Exchange> {
  const method = options.method ?? 'POST'
  const headers = options.headers ?? { 'content-type': 'application/json', cookie: 'dsh=browser' }
  const body = options.body
    ?? JSON.stringify({ type: 'client-request', rpcId: 'probe-1', method: endpoint, payload })
  const req = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  req.method = method
  req.url = `${STREAM_SETTINGS_RPC_CHANNEL}/${endpoint}`
  req.headers = headers
  const state: Exchange = { status: 0, body: '' }
  const res = {
    writeHead(status: number) { state.status = status; return res },
    end(value?: string) { state.body = value ?? '' },
    on() { return res },
  } as unknown as ServerResponse
  await route.handler(req, res)
  return state
}

describe('smooth-stream settings channel fallback', () => {
  it('prefers the service channel with both services injected on modern settings', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    const webServer = fakeWebServer(routes)
    ctx.provide('webServer', webServer as never)
    ctx.provide('settings', { settings: {} } as never)
    let handler: ConnectionRpcHandler | undefined
    let removed = 0
    class Connection extends Service {
      constructor(ctx: Context) { super(ctx, 'connection') }
      get rpc() {
        const owner = this.ctx
        return {
          handle(channel: string, callback: ConnectionRpcHandler) {
            expect(owner.webServer).toBe(webServer)
            expect(channel).toBe(STREAM_SETTINGS_RPC_CHANNEL)
            handler = callback
            return () => { removed += 1 }
          },
        }
      }
    }
    await ctx.plugin(Connection).await()
    const fiber = ctx.plugin({ apply, Config })
    await fiber.await()
    mounted.push(() => fiber.dispose())
    expect(handler).toBeTypeOf('function')
    expect(routes).toEqual([])
    expect(await handler!(STREAM_SETTINGS_RPC.read, {}, new AbortController().signal))
      .toMatchObject({ ok: true, value: { writable: false, controlScroll: false } })
    await fiber.dispose()
    mounted.pop()
    expect(removed).toBe(1)
  })

  it('mounts the channel directly when the connection service cannot, and serves the settings', async () => {
    const host = await mountHost(true)
    mounted.push(host.dispose)

    const route = host.routes.find(candidate => candidate.path === STREAM_SETTINGS_RPC_CHANNEL)
    expect(route).toMatchObject({ kind: 'prefix', path: STREAM_SETTINGS_RPC_CHANNEL })

    const read = await call(route as WebRoute, STREAM_SETTINGS_RPC.read, {})
    expect(read.status).toBe(200)
    expect(JSON.parse(read.body)).toEqual({
      type: 'server-response',
      rpcId: 'probe-1',
      result: {
        ok: true,
        value: {
          version: STREAM_PACKAGE_VERSION,
          installation: 'unmanaged',
          writable: true,
          enabled: DEFAULT_STREAM_SETTINGS.enabled,
          controlScroll: DEFAULT_STREAM_SETTINGS.controlScroll,
          preset: DEFAULT_STREAM_SETTINGS.preset,
          motionPreference: DEFAULT_STREAM_SETTINGS.motionPreference,
          thinkRunning: DEFAULT_STREAM_SETTINGS.thinkRunning,
          thinkSettled: DEFAULT_STREAM_SETTINGS.thinkSettled,
          thinkHeight: DEFAULT_STREAM_SETTINGS.thinkHeight,
          turnFold: DEFAULT_STREAM_SETTINGS.turnFold,
          logarithmicFade: DEFAULT_STREAM_SETTINGS.logarithmicFade,
          canUpgrade: false,
        },
      },
    })

    const write = await call(route as WebRoute, STREAM_SETTINGS_RPC.write, {
      enabled: false,
      controlScroll: true,
      thinkRunning: 'expanded',
    })
    expect(JSON.parse(write.body)).toMatchObject({
      result: { ok: true, value: { enabled: false, controlScroll: true } },
    })
    expect(host.ctx.settings.get(STREAM_SETTINGS_NS as SettingsNamespace))
      .toMatchObject({ enabled: false, controlScroll: true })

    await host.dispose()
    mounted.pop()
    expect(host.routes).toEqual([])
  })

  it('keeps the connection request fence and the router rules on the direct route', async () => {
    const host = await mountHost(true)
    mounted.push(host.dispose)
    const route = host.routes.find(candidate => candidate.path === STREAM_SETTINGS_RPC_CHANNEL) as WebRoute

    const anonymous = await call(route, STREAM_SETTINGS_RPC.read, {}, { headers: { 'content-type': 'application/json' } })
    expect(anonymous).toEqual({ status: 401, body: 'unauthorized' })

    const wrongMethod = await call(route, STREAM_SETTINGS_RPC.read, {}, { method: 'GET' })
    expect(wrongMethod.status).toBe(404)

    const wrongType = await call(route, STREAM_SETTINGS_RPC.read, {}, { headers: { 'content-type': 'text/plain', cookie: 'dsh=browser' } })
    expect(wrongType.status).toBe(415)

    const notJson = await call(route, STREAM_SETTINGS_RPC.read, {}, { body: 'not json' })
    expect(notJson.status).toBe(400)

    const mismatched = await call(route, STREAM_SETTINGS_RPC.read, {}, {
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe-2', method: 'settings.write', payload: {} }),
    })
    expect(JSON.parse(mismatched.body)).toMatchObject({
      rpcId: 'probe-2',
      result: { ok: false, error: { code: 'gateway/bad-request' } },
    })

    const malformed = await call(route, STREAM_SETTINGS_RPC.read, {}, { body: JSON.stringify({ rpcId: 7 }) })
    expect(JSON.parse(malformed.body)).toMatchObject({
      rpcId: 'invalid-request',
      result: { ok: false, error: { code: 'gateway/bad-request' } },
    })
  })

  it('fails closed instead of exposing the channel without the connection fence', async () => {
    const host = await mountHost(false)
    mounted.push(host.dispose)
    expect(host.routes).toEqual([])
    // The plugin still applies: only the card's read is unavailable.
    expect(host.ctx.settings.get(STREAM_SETTINGS_NS as SettingsNamespace)).toEqual(DEFAULT_STREAM_SETTINGS)
  })
})

describe('smooth-stream settings channel with connection.admit', () => {
  it('keeps the legacy fence authoritative when both APIs exist', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    const requestRejection = vi.fn(() => 403 as const)
    const admit = vi.fn(() => ({ peer: {} }))
    const handler = vi.fn<ConnectionRpcHandler>(async () => ({ ok: true, value: {} }))
    ctx.provide('webServer', fakeWebServer(routes) as never)
    ctx.provide('connection', { requestRejection, admit } as never)
    const authentication = ctx.plugin((authCtx) => { authCtx.provide('connection.authentication', {}) })
    await authentication.await()
    const fiber = ctx.plugin({
      inject: ['connection', 'webServer'],
      apply(channelCtx: Context) {
        return registerSettingsChannel(channelCtx, STREAM_SETTINGS_RPC_CHANNEL, handler)
      },
    })
    await fiber.await()
    mounted.push(() => ctx.fiber.dispose())
    expect(routes).toHaveLength(1)
    expect(await call(routes[0]!, STREAM_SETTINGS_RPC.read, {})).toEqual({ status: 403, body: 'forbidden' })
    expect(requestRejection).toHaveBeenCalledOnce()
    await authentication.dispose()
    expect(routes).toHaveLength(1)
    expect((await call(routes[0]!, STREAM_SETTINGS_RPC.read, {})).status).toBe(403)
    expect(admit).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  /** Exercise both admit generations without changing the suite's pinned kernel. */
  async function mountAdmissionHost(nestedAuthentication: boolean) {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeWebServer(routes) as never)
    const peer = { principal: { kind: 'owner' } }
    const authenticate = vi.fn((request: IncomingMessage) => {
      if (request.headers.origin === 'https://untrusted.example') return { rejection: 403 as const }
      if (request.headers.cookie === undefined) return { rejection: 401 as const }
      if (request.headers.cookie === 'unavailable') return { rejection: 503 as const }
      return { peer }
    })
    const authentication = nestedAuthentication
      ? ctx.plugin((authCtx) => { authCtx.provide('connection.authentication', { authenticate }) })
      : undefined
    await authentication?.await()
    class Connection extends Service {
      readonly authentication = { authenticate }
      constructor(ctx: Context) { super(ctx, 'connection') }
      get rpc() {
        return {
          handle() { throw new Error('cannot get property "webServer" without inject') },
        }
      }
      admit(request: IncomingMessage) {
        if (!nestedAuthentication) return authenticate(request)
        // Model 0.2.3's strict injection check, even under the pinned Cordis.
        expect(this.ctx.fiber.inject).toHaveProperty('connection')
        expect(this.ctx.fiber.inject).toHaveProperty('connection.authentication')
        return this.authentication.authenticate(request)
      }
    }
    await ctx.plugin(Connection).await()
    const handler = vi.fn<ConnectionRpcHandler>(async () => ({ ok: true, value: 'settings' }))
    let release: (() => void) | undefined
    const fiber = ctx.plugin({
      inject: ['connection', 'webServer'],
      apply(channelCtx: Context) {
        release = registerSettingsChannel(channelCtx, STREAM_SETTINGS_RPC_CHANNEL, handler)
      },
    })
    await fiber.await()
    mounted.push(() => ctx.fiber.dispose())
    return { ctx, routes, fiber, authentication, authenticate, handler, release: () => release?.() }
  }

  it.each([false, true])('serves admitted requests (nested authentication: %s)', async (nestedAuthentication) => {
    const host = await mountAdmissionHost(nestedAuthentication)
    const route = host.routes.find(candidate => candidate.path === STREAM_SETTINGS_RPC_CHANNEL)
    expect(route).toBeDefined()
    const response = await call(route!, STREAM_SETTINGS_RPC.read, {})
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ result: { ok: true, value: 'settings' } })
    expect(host.authenticate).toHaveBeenCalledOnce()
    expect(host.handler).toHaveBeenCalledOnce()
    await host.fiber.dispose()
    expect(host.routes).toEqual([])
  })

  it.each([false, true])('preserves all rejection statuses before dispatch (nested authentication: %s)', async (nestedAuthentication) => {
    const host = await mountAdmissionHost(nestedAuthentication)
    const route = host.routes.find(candidate => candidate.path === STREAM_SETTINGS_RPC_CHANNEL)
    expect(route).toBeDefined()
    for (const [headers, status, body] of [
      [{ 'content-type': 'application/json' }, 401, 'unauthorized'],
      [{ cookie: 'dsh=browser', origin: 'https://untrusted.example' }, 403, 'forbidden'],
      [{ cookie: 'unavailable' }, 503, 'service unavailable'],
    ] as const) {
      expect(await call(route!, STREAM_SETTINGS_RPC.read, {}, { headers })).toEqual({ status, body })
    }
    expect(host.handler).not.toHaveBeenCalled()
  })

  it('withdraws and remounts the nested route with its authentication service', async () => {
    const host = await mountAdmissionHost(true)
    expect(host.routes).toHaveLength(1)
    await host.authentication!.dispose()
    expect(host.routes).toEqual([])
    await host.ctx.plugin((authCtx) => {
      authCtx.provide('connection.authentication', { authenticate: host.authenticate })
    }).await()
    expect(host.routes).toHaveLength(1)
    expect((await call(host.routes[0]!, STREAM_SETTINGS_RPC.read, {})).status).toBe(200)
  })

  it('withdraws the nested route when the channel is explicitly released', async () => {
    const host = await mountAdmissionHost(true)
    expect(host.routes).toHaveLength(1)
    await host.release()
    await host.release()
    expect(host.routes).toEqual([])
    await host.authentication!.dispose()
    await host.ctx.plugin((authCtx) => {
      authCtx.provide('connection.authentication', { authenticate: host.authenticate })
    }).await()
    expect(host.routes).toEqual([])
  })
})

describe('smooth-stream settings channel on dsh 0.2.x', () => {
  /**
   * Mount the Host half over a 0.2.x-shaped settings service — present, but
   * without the legacy `register` capability — so the read-only branch serves
   * the card from the composition config.
   */
  async function mountHost02(config?: { controlScroll?: boolean }, connected = true): Promise<{ dispose: () => Promise<void>; routes: WebRoute[] }> {
    const ctx = new Context()
    ctx.baseUrl = `${pathToFileURL(process.cwd()).href}/`
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeWebServer(routes) as never)
    ctx.provide('settings', { settings: {} } as never)
    if (connected) {
      ctx.provide('connection', {
        requestRejection(request: IncomingMessage) {
          return request.headers.cookie === undefined ? 401 : undefined
        },
      } as never)
    }
    // The schema fills omitted fields, so a partial overlay-style config is
    // valid at runtime; the cast only widens cordis's fully-resolved type.
    const fiber = ctx.plugin({ apply, Config }, config as never)
    await fiber.await()
    return { routes, dispose: () => fiber.dispose() }
  }

  afterEach(async () => {
    for (const dispose of mounted.splice(0)) await dispose()
  })

  const readView = async (routes: WebRoute[]): Promise<Record<string, unknown>> => {
    const route = routes.find(candidate => candidate.path === STREAM_SETTINGS_RPC_CHANNEL)
    expect(route).toMatchObject({ kind: 'prefix', path: STREAM_SETTINGS_RPC_CHANNEL })
    const read = await call(route as WebRoute, STREAM_SETTINGS_RPC.read, {})
    expect(read.status).toBe(200)
    return (JSON.parse(read.body) as { result: { value: Record<string, unknown> } }).result.value
  }

  it('defaults the takeover off — native bottom-follow — on the read-only branch', async () => {
    const host = await mountHost02()
    mounted.push(host.dispose)
    const view = await readView(host.routes)
    expect(view).toMatchObject({ writable: false, controlScroll: false, enabled: true })
  })

  it('restores the takeover when the overlay config asks for it', async () => {
    const host = await mountHost02({ controlScroll: true })
    mounted.push(host.dispose)
    const view = await readView(host.routes)
    expect(view).toMatchObject({ writable: false, controlScroll: true })
  })

  it('waits for connection instead of mounting an unauthenticated modern channel', async () => {
    const host = await mountHost02(undefined, false)
    mounted.push(host.dispose)
    expect(host.routes).toEqual([])
  })
})
