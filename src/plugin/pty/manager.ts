import type { SessionClient } from '../types.ts'
import { Terminal } from 'bun-pty'
import { NotificationManager } from './notification-manager.ts'
import { OutputManager } from './output-manager.ts'
import { SessionLifecycleManager } from './session-lifecycle.ts'
import type { SnapshotDiff, WaitCondition, WaitResult } from './snapshot.ts'
import type {
  PTYSessionInfo,
  PTYStatus,
  ReadResult,
  SearchResult,
  SnapshotResult,
  SpawnOptions,
} from './types.ts'
import { withSession } from './utils.ts'
import { currentRuntime } from './runtime.ts'

const proto = Terminal.prototype as unknown as { _startReadLoop?: (...args: unknown[]) => unknown }

const original = proto._startReadLoop

if (typeof original === 'function') {
  proto._startReadLoop = async function (this: InstanceType<typeof Terminal>, ...args: unknown[]) {
    await Promise.resolve() // Yield to allow event handlers to be registered
    return original.apply(this, args)
  }
}

type SessionUpdateCallback = (session: PTYSessionInfo) => void

export const sessionUpdateCallbacks: SessionUpdateCallback[] = []

export function registerSessionUpdateCallback(callback: SessionUpdateCallback) {
  getManager().sessionUpdateCallbacks.push(callback)
}

export function removeSessionUpdateCallback(callback: SessionUpdateCallback) {
  const callbacks = getManager().sessionUpdateCallbacks
  const index = callbacks.indexOf(callback)
  if (index !== -1) {
    callbacks.splice(index, 1)
  }
}

function notifySessionUpdate(session: PTYSessionInfo, callbacks: SessionUpdateCallback[]) {
  for (const callback of [...callbacks]) {
    try {
      callback(session)
    } catch {
      // Ignore callback errors
    }
  }
}

type RawOutputCallback = (session: PTYSessionInfo, rawData: string) => void

export const rawOutputCallbacks: RawOutputCallback[] = []

export function registerRawOutputCallback(callback: RawOutputCallback): void {
  getManager().rawOutputCallbacks.push(callback)
}

export function removeRawOutputCallback(callback: RawOutputCallback): void {
  const callbacks = getManager().rawOutputCallbacks
  const index = callbacks.indexOf(callback)
  if (index !== -1) {
    callbacks.splice(index, 1)
  }
}

function notifyRawOutput(
  session: PTYSessionInfo,
  rawData: string,
  callbacks: RawOutputCallback[]
): void {
  for (const callback of [...callbacks]) {
    try {
      callback(session, rawData)
    } catch {
      // Ignore callback errors
    }
  }
}

export class PTYManager {
  private disposed = false
  constructor(
    readonly sessionUpdateCallbacks: SessionUpdateCallback[] = [],
    readonly rawOutputCallbacks: RawOutputCallback[] = []
  ) {}
  private lifecycleManager = new SessionLifecycleManager()
  private outputManager = new OutputManager()
  private notificationManager = new NotificationManager()
  private client: SessionClient | null = null

  private canAccess(id: string): boolean {
    const runtime = currentRuntime()
    const owner = runtime?.manager === this ? runtime.sessionID : undefined
    return !owner || this.lifecycleManager.getSession(id)?.parentSessionId === owner
  }

  init(client: SessionClient): void {
    this.client = client
    this.notificationManager.init(client)
  }

  async isChildSession(sessionId: string): Promise<boolean> {
    if (!this.client) return false

    try {
      const session = await this.client.session.get({ path: { id: sessionId } })
      return Boolean((session.data as { parentID?: string } | undefined)?.parentID)
    } catch {
      return false
    }
  }

  clearAllSessions(): void {
    for (const session of this.lifecycleManager.listSessions()) this.kill(session.id, true)
  }

  dispose(): void {
    this.disposed = true
    this.clearAllSessions()
  }

  spawn(opts: SpawnOptions): PTYSessionInfo {
    if (this.disposed) throw new Error('PTY manager has been disposed')
    currentRuntime()?.signal?.throwIfAborted()
    const session = this.lifecycleManager.spawn(
      opts,
      (session, data) => {
        notifyRawOutput(this.lifecycleManager.toInfo(session), data, this.rawOutputCallbacks)
      },
      async (session, exitCode) => {
        notifySessionUpdate(this.lifecycleManager.toInfo(session), this.sessionUpdateCallbacks)
        if (session?.notifyOnExit) {
          await this.notificationManager.sendExitNotification(session, exitCode || 0)
        }
      }
    )
    notifySessionUpdate(session, this.sessionUpdateCallbacks)
    return session
  }

  write(id: string, data: string): boolean {
    if (!this.canAccess(id)) return false
    return withSession(
      this.lifecycleManager,
      id,
      (session) => this.outputManager.write(session, data),
      false
    )
  }

  read(id: string, offset: number = 0, limit?: number): ReadResult | null {
    if (!this.canAccess(id)) return null
    return withSession(
      this.lifecycleManager,
      id,
      (session) => this.outputManager.read(session, offset, limit),
      null
    )
  }

  search(id: string, pattern: RegExp, offset: number = 0, limit?: number): SearchResult | null {
    if (!this.canAccess(id)) return null
    return withSession(
      this.lifecycleManager,
      id,
      (session) => this.outputManager.search(session, pattern, offset, limit),
      null
    )
  }

  list(): PTYSessionInfo[] {
    return this.lifecycleManager
      .listSessions()
      .filter((session) => this.canAccess(session.id))
      .map((session) => this.lifecycleManager.toInfo(session))
  }

  get(id: string): PTYSessionInfo | null {
    if (!this.canAccess(id)) return null
    return withSession(
      this.lifecycleManager,
      id,
      (session) => this.lifecycleManager.toInfo(session),
      null
    )
  }

  getRawBuffer(id: string): { raw: string; byteLength: number } | null {
    if (!this.canAccess(id)) return null
    return withSession(
      this.lifecycleManager,
      id,
      (session) => ({
        raw: session.buffer.readRaw(),
        byteLength: session.buffer.byteLength,
      }),
      null
    )
  }

  snapshot(id: string): SnapshotResult | null {
    if (!this.canAccess(id)) return null
    return withSession(
      this.lifecycleManager,
      id,
      (session) => this.outputManager.snapshot(session),
      null
    )
  }

  snapshotDiff(
    id: string,
    sinceSeq: number
  ): (SnapshotDiff & { id: string; status: PTYStatus }) | null {
    if (!this.canAccess(id)) return null
    return withSession(
      this.lifecycleManager,
      id,
      (session) => this.outputManager.snapshotDiff(session, sinceSeq),
      null
    )
  }

  async snapshotWait(
    id: string,
    condition: WaitCondition
  ): Promise<(WaitResult & { id: string; status: string }) | null> {
    if (!this.canAccess(id)) return null
    const session = this.lifecycleManager.getSession(id)
    if (!session) return null
    return this.outputManager.snapshotWait(session, condition)
  }

  kill(id: string, cleanup: boolean = false): boolean {
    if (!this.canAccess(id)) return false
    const session = cleanup ? this.get(id) : null
    const success = this.lifecycleManager.kill(id, cleanup)
    if (success && session)
      notifySessionUpdate(
        {
          ...session,
          status:
            session.status === 'running' || session.status === 'killing'
              ? 'killed'
              : session.status,
          exitAt: session.exitAt ?? new Date().toISOString(),
        },
        this.sessionUpdateCallbacks
      )
    return success
  }

  async snapshotText(id: string): Promise<string | null> {
    if (!this.canAccess(id)) return null
    const session = this.lifecycleManager.getSession(id)
    return session ? session.snapshot.getSettledText() : null
  }

  cleanupBySession(parentSessionId: string): void {
    for (const session of this.lifecycleManager.listSessions()) {
      if (session.parentSessionId === parentSessionId) this.kill(session.id, true)
    }
  }
}

export const manager = new PTYManager(sessionUpdateCallbacks, rawOutputCallbacks)

export function getManager(): PTYManager {
  return currentRuntime()?.manager ?? manager
}

export function initManager(opcClient: SessionClient): void {
  manager.init(opcClient)
}
