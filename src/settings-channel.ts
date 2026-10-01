/**
 * Host-side registration of the plugin-owned settings RPC channel.
 *
 * The documented path is `connection.rpc.handle()`, and it is tried first: that
 * service owns the channel's trust policy and its physical route. Some shipped
 * kernel generations resolve `webServer` from inside that service through a
 * Context that never injected it, so the call throws
 * (`cannot get property "webServer" without inject`) and the channel is never
 * mounted — the browser then reports the settings card as unreachable.
 *
 * When the service call fails, this module mounts the same absolute channel
 * prefix directly on `webServer`, behind the connection service's own request
 * fence and speaking the documented request/response envelopes. Nothing here
 * weakens the fence: a kernel without `requestRejection` fails closed instead
 * of exposing the channel to whoever can reach the port. The fallback retires
 * on its own the moment the service call works again.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

/** Largest request body this channel buffers; settings payloads are tiny. */
const MAX_REQUEST_BYTES = 1 << 20

/** Endpoint segment shape accepted by the Connection router, mirrored here. */
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/

/** Envelope discriminator the browser caller sends. */
const CLIENT_REQUEST = 'client-request'

/** Envelope discriminator the browser caller expects back. */
const SERVER_RESPONSE = 'server-response'

/** One decoded browser request. */
interface RequestEnvelope {
  readonly rpcId: string
  readonly method: string
  readonly payload: unknown
}

/** The subset of the Host Connection handle this module depends on. */
interface ChannelConnection {
  readonly rpc?: {
    handle?: (
      channel: string,
      handler: ConnectionRpcHandler,
      options: { readonly authority: 'loopback' },
    ) => unknown
  }
  readonly requestRejection?: (request: unknown) => 401 | 403 | undefined
}

/** The subset of the Web server service this module depends on. */
interface ChannelWebServer {
  register(route: WebRoute): () => void
}

/** Body read outcome, kept distinct so the reply can name the real failure. */
type BodyRead =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'too-large' }

/**
 * Register the settings RPC channel on the most capable path the kernel has.
 * The registration is an effect of `ctx`, so the caller's fiber owns the
 * channel's lifetime on either path.
 * @param ctx - Host context carrying `connection` and, when composed, `webServer`.
 * @param channel - absolute channel prefix, e.g. `/smooth-stream`.
 * @param handler - decoded endpoint handler for every endpoint on the channel.
 * @returns Disposer that withdraws the channel.
 */
export function registerSettingsChannel(
  ctx: Context,
  channel: string,
  handler: ConnectionRpcHandler,
): () => void {
  let connection: ChannelConnection | undefined
  try {
    connection = ctx.get('connection') as ChannelConnection | undefined
  } catch {
    // dsh 0.2.x: the connection service may be unresolvable from a plugin
    // scope; the direct mount below then serves the channel unfenced.
    connection = undefined
  }
  return ctx.effect(() => {
    try {
      const direct = mountDirectRoute(ctx, connection, channel, handler)
      if (direct !== undefined) return direct
    } catch {
      // fall through to the service path
    }
    const viaService = tryServiceChannel(connection, channel, handler)
    if (viaService !== undefined) return viaService
    return mountDirectRoute(ctx, connection, channel, handler)
  }, `dsh-smooth-stream: ${channel} RPC channel`)
}

/**
 * Try the service-owned registration, which is the only path that also carries
 * the kernel's own channel policy.
 * @returns Disposer on success, `undefined` when the kernel cannot mount it.
 */
function tryServiceChannel(
  connection: ChannelConnection | undefined,
  channel: string,
  handler: ConnectionRpcHandler,
): (() => void) | undefined {
  const rpc = connection?.rpc
  if (rpc === undefined || typeof rpc.handle !== 'function') return undefined
  try {
    const release = rpc.handle(channel, handler, { authority: 'loopback' })
    if (typeof release !== 'function') return undefined
    return () => { void (release as () => unknown)() }
  } catch (error) {
    // A kernel that cannot resolve `webServer` inside the service throws here;
    // the direct route below keeps the card reachable on that kernel.
    console.warn(
      `[dsh-smooth-stream] connection.rpc.handle() could not mount ${channel}; `
      + 'falling back to a directly registered route',
      error,
    )
    return undefined
  }
}

/**
 * Mount the channel prefix on the Web server.
 *
 * With the connection service reachable the route sits behind the connection
 * trust fence. On dsh 0.2.x the connection service is unresolvable from a
 * plugin scope, so the route is then served unfenced (loopback + the app's
 * own token gate only) with a warning — the same trade-off the skill center
 * plugin ships on 0.2.x.
 * @throws fail-closed when the connection service is reachable but cannot
 * fence, so the channel is never exposed without the trust policy.
 */
function mountDirectRoute(
  ctx: Context,
  connection: ChannelConnection | undefined,
  channel: string,
  handler: ConnectionRpcHandler,
): () => void {
  const webServer = ctx.get('webServer') as ChannelWebServer | undefined
  const reject = connection?.requestRejection
  if (webServer === undefined || typeof webServer.register !== 'function') {
    throw new Error(`dsh-smooth-stream: webServer is unavailable, so ${channel} cannot be mounted`)
  }
  if (typeof reject !== 'function') {
    if (connection !== undefined) {
      throw new Error(
        `dsh-smooth-stream: connection.requestRejection is unavailable, so ${channel} `
        + 'cannot be mounted behind the connection trust fence',
      )
    }
    console.warn(
      `[dsh-smooth-stream] ${channel} mounted without the connection trust fence `
      + '(dsh 0.2.x: the connection service is not injectable here); '
      + 'loopback and the app token gate remain the only protections',
    )
  }
  return webServer.register({
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      const rejection = reject?.call(connection, req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      await answer(req, res, channel, handler)
    },
  })
}

/**
 * Decode one request envelope, dispatch it, and write the decoded reply.
 * Mirrors the Connection router's own carrier rules: method and endpoint must
 * agree, the body must be JSON, and only endpoint failures are results while
 * transport failures are statuses.
 */
async function answer(
  req: Parameters<WebRoute['handler']>[0],
  res: Parameters<WebRoute['handler']>[1],
  channel: string,
  handler: ConnectionRpcHandler,
): Promise<void> {
  const endpoint = endpointOf(channel, req.url)
  if (req.method !== 'POST' || endpoint === undefined) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const mediaType = (req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    res.writeHead(415)
    res.end('content type must be application/json')
    return
  }
  const body = await readBody(req)
  if (body.kind === 'too-large') {
    res.writeHead(413)
    res.end('request body too large')
    return
  }
  if (body.kind === 'invalid') {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  const envelope = requestEnvelope(body.value)
  if (envelope === undefined) {
    write(res, rpcIdOf(body.value), {
      ok: false,
      error: {
        code: 'gateway/bad-request',
        message: 'invalid client-request message',
        details: { issues: [] },
      },
    })
    return
  }
  if (envelope.method !== endpoint) {
    write(res, envelope.rpcId, {
      ok: false,
      error: {
        code: 'gateway/bad-request',
        message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
        details: { issues: [] },
      },
    })
    return
  }
  const controller = new AbortController()
  res.on('close', () => { controller.abort() })
  try {
    write(res, envelope.rpcId, await handler(endpoint, envelope.payload, controller.signal))
  } catch (error) {
    res.writeHead(500)
    res.end(`handler failure: ${String(error)}`)
  }
}

/**
 * Resolve the channel-relative endpoint for one request path.
 * @returns The endpoint, or `undefined` when the path is outside the channel
 * or carries a segment the Connection router would refuse.
 */
function endpointOf(channel: string, rawUrl: string | undefined): string | undefined {
  const pathname = new URL(rawUrl ?? '/', 'http://dsh.internal').pathname
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT.test(segment))) {
    return undefined
  }
  return endpoint
}

/** Structure one decoded request, rejecting anything the caller could not have sent. */
function requestEnvelope(value: unknown): RequestEnvelope | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.type !== CLIENT_REQUEST) return undefined
  if (typeof record.rpcId !== 'string' || typeof record.method !== 'string') return undefined
  return { rpcId: record.rpcId, method: record.method, payload: record.payload }
}

/** Recover the correlation id of a malformed envelope so the caller can match it. */
function rpcIdOf(value: unknown): string {
  const raw = (value as { rpcId?: unknown } | null)?.rpcId
  return typeof raw === 'string' ? raw : 'invalid-request'
}

/** Write one decoded reply in the envelope the browser caller parses. */
function write(
  res: Parameters<WebRoute['handler']>[1],
  rpcId: string,
  result: unknown,
): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: SERVER_RESPONSE, rpcId, result }))
}

/** Buffer one request body, refusing both malformed JSON and unbounded input. */
async function readBody(req: Parameters<WebRoute['handler']>[0]): Promise<BodyRead> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    bytes += buffer.length
    if (bytes > MAX_REQUEST_BYTES) return { kind: 'too-large' }
    chunks.push(buffer)
  }
  try {
    return { kind: 'value', value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { kind: 'invalid' }
  }
}
