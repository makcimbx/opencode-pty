import type { Server } from 'bun'
import { routes } from '../shared/routes.ts'
import { CallbackManager } from './callback-manager.ts'
import { handleHealth } from './handlers/health.ts'
import {
  cleanupSession,
  clearSessions,
  createSession,
  getPlainBuffer,
  getRawBuffer,
  getSession,
  getSessions,
  killSession,
  sendInput,
} from './handlers/sessions.ts'
import { buildStaticRoutes } from './handlers/static.ts'
import { handleUpgrade } from './handlers/upgrade.ts'
import { handleWebSocketMessage } from './handlers/websocket.ts'
import { ServerAuth } from './auth.ts'
import { currentRuntime, ptyRuntime, type PTYRuntime } from '../../plugin/pty/runtime.ts'

export interface ServerOptions {
  runtime?: PTYRuntime
  port?: number
  hostname?: string
}

export class PTYServer implements Disposable {
  public readonly server: Server<undefined>
  private readonly staticRoutes: Record<string, Response>
  private readonly stack = new DisposableStack()
  readonly auth = new ServerAuth()

  private constructor(
    staticRoutes: Record<string, Response>,
    private readonly options: ServerOptions
  ) {
    this.staticRoutes = staticRoutes
    this.server = this.startWebServer()
    this.stack.use(this.server)
    this.stack.use(this.run(() => new CallbackManager(this.server)))
  }

  [Symbol.dispose]() {
    this.server.stop(true)
    this.stack.dispose()
  }

  public static async createServer(options: ServerOptions = {}): Promise<PTYServer> {
    const staticRoutes = await buildStaticRoutes()

    const runtime = options.runtime ?? currentRuntime()
    return new PTYServer(staticRoutes, {
      ...options,
      runtime: runtime ? { ...runtime, sessionID: undefined, agent: undefined } : undefined,
    })
  }

  createBrowserUrl(): string {
    return this.auth.createBrowserUrl(this.server.url.origin)
  }

  private run<T>(handler: () => T): T {
    return this.options.runtime ? ptyRuntime.run(this.options.runtime, handler) : handler()
  }

  private guard<T extends Request>(
    handler: (request: T) => Response | Promise<Response> | undefined
  ) {
    return (request: T) => {
      const origin = this.server.url.origin
      if (
        new URL(request.url).origin !== origin ||
        (request.headers.has('origin') && request.headers.get('origin') !== origin)
      ) {
        return new Response('Invalid origin', { status: 403 })
      }
      if (!this.auth.authorized(request)) return new Response('Unauthorized', { status: 401 })
      return this.run(() => handler(request))
    }
  }

  private startWebServer(): Server<undefined> {
    return Bun.serve({
      port:
        this.options.port ??
        (process.env.PTY_WEB_PORT ? parseInt(process.env.PTY_WEB_PORT, 10) : 0),
      hostname: this.options.hostname ?? process.env.PTY_WEB_HOSTNAME ?? '::1',

      routes: {
        ...Object.fromEntries(
          Object.entries(this.staticRoutes).map(([path, response]) => [
            path,
            this.guard(() => response.clone()),
          ])
        ),
        '/auth/:nonce': (req) => {
          if (
            new URL(req.url).origin !== this.server.url.origin ||
            (req.headers.has('origin') && req.headers.get('origin') !== this.server.url.origin)
          ) {
            return new Response('Invalid origin', { status: 403 })
          }
          if (!this.auth.consume(req.params.nonce))
            return new Response('Link expired or already used', { status: 401 })
          return new Response(null, {
            status: 302,
            headers: {
              Location: '/index.html',
              'Set-Cookie': this.auth.cookie(),
              'Cache-Control': 'no-store',
              'Referrer-Policy': 'no-referrer',
            },
          })
        },
        [routes.websocket.path]: this.guard((req: Request) => handleUpgrade(this.server, req)),
        [routes.health.path]: () => handleHealth(this.server),
        [routes.sessions.path]: {
          GET: this.guard(getSessions),
          POST: this.guard(createSession),
          DELETE: this.guard(clearSessions),
        },
        [routes.session.path]: {
          GET: this.guard(getSession),
          DELETE: this.guard(killSession),
        },
        [routes.session.cleanup.path]: {
          DELETE: this.guard(cleanupSession),
        },
        [routes.session.input.path]: {
          POST: this.guard(sendInput),
        },
        [routes.session.buffer.raw.path]: {
          GET: this.guard(getRawBuffer),
        },
        [routes.session.buffer.plain.path]: {
          GET: this.guard(getPlainBuffer),
        },
      },

      websocket: {
        data: undefined as undefined,
        perMessageDeflate: true,
        open: (ws) => ws.subscribe('sessions:update'),
        message: (ws, message) => this.run(() => handleWebSocketMessage(ws, message)),
        close: (ws) => {
          ws.subscriptions.forEach((topic) => {
            ws.unsubscribe(topic)
          })
        },
      },

      fetch: this.guard(
        () => new Response(null, { status: 302, headers: { Location: '/index.html' } })
      ),
    })
  }

  public getWsUrl(): string {
    return `${this.server.url.origin.replace(/^http/, 'ws')}${routes.websocket.path}`
  }
}
