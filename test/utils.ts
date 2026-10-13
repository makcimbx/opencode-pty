import { OpencodeClient } from '@opencode-ai/sdk'
import {
  initManager,
  manager,
  sessionUpdateCallbacks,
  rawOutputCallbacks,
} from '../src/plugin/pty/manager'
import { PTYServer } from '../src/web/server/server'
import type {
  WSMessageServer,
  WSMessageServerSubscribedSession,
  WSMessageServerUnsubscribedSession,
  WSMessageServerSessionUpdate,
  WSMessageServerRawData,
  WSMessageServerReadRawResponse,
  WSMessageServerSessionList,
  WSMessageServerError,
  WSMessageClientInput,
  WSMessageClientSessionList,
  WSMessageClientSpawnSession,
  WSMessageClientSubscribeSession,
  WSMessageClientUnsubscribeSession,
} from '../src/web/shared/types'

const credentials = new Map<string, string>()

export function testWebSocket(url: string, token?: string): WebSocket {
  // DOM libs narrow the global constructor; Bun supports HTTP handshake headers.
  const Client = WebSocket as unknown as {
    new (url: string, options: Bun.WebSocketOptions): WebSocket
  }
  // Bun's IPv6 WebSocket handshake otherwise drops the port from Host.
  return new Client(url, {
    headers: { Host: new URL(url).host, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
}

/** Keep Unix coverage on Unix; use native processes on Windows, not WSL aliases. */
export function testCommand(
  command: string,
  args: string[] = []
): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command, args }
  const script = (code: string) => ({ command: process.execPath, args: ['-e', code] })
  if (command === 'echo') return script(`console.log(${JSON.stringify(args.join(' '))})`)
  if (command === 'sleep') return script(`setTimeout(()=>{},${Number(args[0]) * 1000})`)
  if (command === 'cat') return script('process.stdin.on("data",data=>process.stdout.write(data))')
  if (command === 'bash' && args.length === 0)
    return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/q'] }
  if (command === 'bash' && args[0] === '-c' && args[1]?.startsWith('printf'))
    return script('console.log("line1\\nline2\\nline3")')
  if (command === 'sh' && args[1] === 'exit 0') return script('process.exit(0)')
  if (command === 'sh' && args[1] === 'sleep 1; exit 0')
    return script('setTimeout(()=>process.exit(0),1000)')
  throw new Error(`No portable fixture for ${command} ${args.join(' ')}`)
}
export function authenticatedFetch(input: string | URL | Request, options: RequestInit = {}) {
  const url = new URL(input instanceof Request ? input.url : input)
  const headers = new Headers(options.headers)
  const token = credentials.get(url.origin)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return globalThis.fetch(input, { ...options, headers })
}

export class ManagedTestClient implements Disposable {
  public readonly ws: WebSocket
  private readonly stack = new DisposableStack()

  public readonly messages: WSMessageServer[] = []
  public readonly subscribedCallbacks: Array<(message: WSMessageServerSubscribedSession) => void> =
    []
  public readonly unsubscribedCallbacks: Array<
    (message: WSMessageServerUnsubscribedSession) => void
  > = []
  public readonly sessionUpdateCallbacks: Array<(message: WSMessageServerSessionUpdate) => void> =
    []
  public readonly rawDataCallbacks: Array<(message: WSMessageServerRawData) => void> = []
  public readonly readRawResponseCallbacks: Array<
    (message: WSMessageServerReadRawResponse) => void
  > = []
  public readonly sessionListCallbacks: Array<(message: WSMessageServerSessionList) => void> = []
  public readonly errorCallbacks: Array<(message: WSMessageServerError) => void> = []

  private constructor(wsUrl: string, token?: string) {
    token ??= credentials.get(new URL(wsUrl.replace(/^ws/, 'http')).origin)
    this.ws = testWebSocket(wsUrl, token)
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data) as WSMessageServer
      this.messages.push(message)
      switch (message.type) {
        case 'subscribed':
          this.subscribedCallbacks.forEach((callback) => {
            callback(message as WSMessageServerSubscribedSession)
          })
          break
        case 'unsubscribed':
          this.unsubscribedCallbacks.forEach((callback) => {
            callback(message as WSMessageServerUnsubscribedSession)
          })
          break
        case 'session_update':
          this.sessionUpdateCallbacks.forEach((callback) => {
            callback(message as WSMessageServerSessionUpdate)
          })
          break
        case 'raw_data':
          this.rawDataCallbacks.forEach((callback) => {
            callback(message as WSMessageServerRawData)
          })
          break
        case 'readRawResponse':
          this.readRawResponseCallbacks.forEach((callback) => {
            callback(message as WSMessageServerReadRawResponse)
          })
          break
        case 'session_list':
          this.sessionListCallbacks.forEach((callback) => {
            callback(message as WSMessageServerSessionList)
          })
          break
        case 'error':
          this.errorCallbacks.forEach((callback) => {
            callback(message as WSMessageServerError)
          })
          break
      }
    }
  }
  [Symbol.dispose]() {
    this.ws.close()
    this.stack.dispose()
  }
  /**
   * Waits until the WebSocket connection is open.
   *
   * The onopen event is broken so we need to wait manually.
   * Problem: if onopen is set after the WebSocket is opened,
   * it will never be called. So we wait here until the readyState is OPEN.
   * This prevents flakiness.
   */
  public async waitOpen() {
    const deadline = Date.now() + 5000
    while (this.ws.readyState !== WebSocket.OPEN) {
      if (this.ws.readyState === WebSocket.CLOSED || Date.now() >= deadline) {
        this.ws.close()
        throw new Error('WebSocket failed to open (check credentials)')
      }
      await new Promise(setImmediate)
    }
  }
  public static async create(wsUrl: string, token?: string) {
    const client = new ManagedTestClient(wsUrl, token)
    await client.waitOpen()
    return client
  }

  /**
   * Verify that a specific character appears in raw_data events within timeout
   */
  async verifyCharacterInEvents(
    sessionId: string,
    chars: string,
    timeout = 5000
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        resolve(false)
      }, timeout)

      let rawData = ''
      this.rawDataCallbacks.push((message) => {
        if (message.session.id !== sessionId) return
        rawData += message.rawData
        if (rawData.includes(chars)) {
          clearTimeout(timeoutId)
          resolve(true)
        }
      })
    })
  }

  public send(
    message:
      | WSMessageClientInput
      | WSMessageClientSessionList
      | WSMessageClientSpawnSession
      | WSMessageClientSubscribeSession
      | WSMessageClientUnsubscribeSession
  ) {
    this.ws.send(JSON.stringify(message))
  }
}

export class ManagedTestServer implements Disposable {
  public readonly server: PTYServer
  private readonly stack = new DisposableStack()
  public readonly sessionId: string

  public static async create() {
    const server = await PTYServer.createServer()

    return new ManagedTestServer(server)
  }

  private constructor(server: PTYServer) {
    const client = new OpencodeClient()
    initManager(client)
    this.server = server
    credentials.set(server.server.url.origin, server.auth.token)
    this.stack.use(this.server)
    this.sessionId = crypto.randomUUID()
  }
  [Symbol.dispose]() {
    this.stack.dispose()
    credentials.delete(this.server.server.url.origin)
    manager.clearAllSessions()
    sessionUpdateCallbacks.length = 0
    rawOutputCallbacks.length = 0
  }
}
