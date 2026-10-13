import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from '@opencode/plugin'
import { PTYPluginV2 } from '../src/plugin/v2.ts'
import { TerminalSnapshot } from '../src/plugin/pty/snapshot.ts'

type Rule = { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }
type Execution = {
  sessionID: string
  agent: string
  signal: AbortSignal
  messageID: string
  id: string
  progress: () => Promise<void>
}
type Tool = { execute(args: unknown, context: Execution): Promise<{ content: string }> }
type Command = { execute(input: { sessionID: string }): Promise<void> }
type Handler = (
  input: { sessionID: string; id?: string },
  context: { signal: AbortSignal }
) => Promise<unknown>

function host(
  directory: string,
  rules: Rule[] = [{ action: '*', resource: '*', effect: 'allow' }]
) {
  const tools = new Map<string, Tool>()
  const commands = new Map<string, Command>()
  const rpc = new Map<string, Handler>()
  const messages: Array<Record<string, unknown>> = []
  const sessions = new Map<
    string,
    { location: { directory: string }; permissions: Rule[]; parentID?: string }
  >()
  const agentQueries: Array<{ agentID: string; location: { directory: string } }> = []
  let disposed = 0
  let closeEvents = () => {}
  const eventsClosed = new Promise<void>((done) => {
    closeEvents = done
  })
  const registration = () => ({
    dispose: async () => {
      disposed++
    },
  })
  const context = {
    location: { directory },
    agent: {
      get: async (input: (typeof agentQueries)[number]) => {
        agentQueries.push(input)
        return { data: { permissions: rules } }
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) =>
        sessions.get(sessionID) ?? { location: { directory }, permissions: [] },
      synthetic: async (message: Record<string, unknown>) => {
        messages.push(message)
      },
    },
    rpc: {
      register: async (_definition: unknown, handlers: Record<string, Handler>) => {
        for (const [name, handler] of Object.entries(handlers)) rpc.set(name, handler)
        return registration()
      },
    },
    tool: {
      transform: async (transform: (editor: unknown) => void) => {
        transform({
          add: (definition: Tool & { name: string }) => tools.set(definition.name, definition),
        })
        return registration()
      },
    },
    command: {
      transform: async (transform: (editor: unknown) => void) => {
        transform({
          add: (definition: Command & { name: string }) =>
            commands.set(definition.name, definition),
        })
        return registration()
      },
    },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        let aborted = () => {}
        const stopped = new Promise<void>((done) => {
          aborted = done
        })
        signal.addEventListener('abort', aborted, { once: true })
        try {
          if (!signal.aborted) await Promise.race([eventsClosed, stopped])
        } finally {
          signal.removeEventListener('abort', aborted)
        }
      },
    },
  }
  return {
    context,
    tools,
    commands,
    rpc,
    sessions,
    messages,
    agentQueries,
    disposed: () => disposed,
    closeEvents,
    setup: () => PTYPluginV2.setup(context as unknown as Plugin.Context),
    execute(
      name: string,
      args: unknown,
      sessionID = 'owner',
      signal = new AbortController().signal
    ) {
      const definition = tools.get(name)
      if (!definition) throw new Error(`Tool missing: ${name}`)
      return definition.execute(args, {
        sessionID,
        agent: 'audit-agent',
        signal,
        messageID: 'msg_test',
        id: 'call_test',
        progress: async () => {},
      })
    },
    call(name: string, input: Parameters<Handler>[0]) {
      const handler = rpc.get(name)
      if (!handler) throw new Error(`RPC missing: ${name}`)
      return handler(input, { signal: new AbortController().signal })
    },
  }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function start(value: ReturnType<typeof host>) {
  const cleanup = await value.setup()
  if (cleanup) cleanups.push(cleanup)
  return value
}
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'pty-v2-test-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}
const spawn = (
  code = 'console.log("READY",process.cwd());setTimeout(()=>process.exit(0),200)'
) => ({
  command: process.execPath,
  args: ['-e', code],
  description: 'V2 regression',
  timeoutSeconds: 10,
})
const idFrom = (result: { content: string }) => {
  const id = result.content.match(/ID: (pty_\w+)/)?.[1]
  if (!id) throw new Error(`PTY ID missing: ${result.content}`)
  return id
}

describe('OpenCode V2 integration', () => {
  it('registers all tools and commands with cleanup', async () => {
    const value = await start(host(process.cwd()))
    expect(value.tools.size).toBe(8)
    expect([...value.commands.keys()]).toEqual(['pty-open-background-spy', 'pty-show-server-url'])
    expect([...value.rpc.keys()]).toEqual(['list', 'output', 'remove', 'clearFinished'])
  })

  it('isolates instance permissions and unloading in both directions', async () => {
    const denied = await start(
      host(process.cwd(), [{ action: '*', resource: '*', effect: 'deny' }])
    )
    const allowed = await start(host(process.cwd()))
    await expect(denied.execute('pty_spawn', spawn())).rejects.toThrow('denied')
    const id = idFrom(await allowed.execute('pty_spawn', spawn()))
    await cleanups[0]?.()
    expect(denied.disposed()).toBe(3)
    expect((await allowed.execute('pty_list', {})).content).toContain(id)
    const deniedAgain = await start(
      host(process.cwd(), [{ action: '*', resource: '*', effect: 'deny' }])
    )
    const secondID = idFrom(await allowed.execute('pty_spawn', spawn()))
    expect(
      (await allowed.execute('pty_wait', { id: secondID, timeoutSeconds: 5 })).content
    ).toContain('Exit: 0')
    await expect(deniedAgain.execute('pty_spawn', spawn())).rejects.toThrow('denied')
  })

  it('uses the invoking session directory and agent; applies ordered session overrides', async () => {
    const directory = await workspace()
    const value = await start(host(process.cwd(), [{ action: '*', resource: '*', effect: 'deny' }]))
    value.sessions.set('moved', {
      location: { directory },
      permissions: [{ action: 'shell', resource: '*', effect: 'allow' }],
    })
    const id = idFrom(await value.execute('pty_spawn', spawn(), 'moved'))
    expect(value.agentQueries[0]).toEqual({ agentID: 'audit-agent', location: { directory } })
    expect((await value.execute('pty_wait', { id, timeoutSeconds: 5 }, 'moved')).content).toContain(
      directory
    )
  })

  it('prevents cross-session reading, listing, writing and killing, including RPC', async () => {
    const value = await start(host(process.cwd()))
    const id = idFrom(await value.execute('pty_spawn', spawn()))
    expect((await value.execute('pty_list', {}, 'stranger')).content).not.toContain(id)
    for (const name of [
      'pty_read',
      'pty_write',
      'pty_kill',
      'pty_snapshot',
      'pty_snapshot_wait',
      'pty_wait',
    ]) {
      await expect(
        value.execute(name, { id, data: '\x03', search: 'READY' }, 'stranger')
      ).rejects.toThrow()
    }
    expect(await value.call('list', { sessionID: 'stranger' })).toEqual([])
    expect(await value.call('remove', { sessionID: 'stranger', id })).toEqual({ success: false })
    expect((await value.execute('pty_list', {})).content).toContain(id)
  })

  it('cancels waits promptly without killing the process', async () => {
    const value = await start(host(process.cwd()))
    const id = idFrom(
      await value.execute('pty_spawn', spawn('setTimeout(()=>process.exit(0),5000)'))
    )
    for (const [name, args] of [
      ['pty_wait', { id }],
      ['pty_snapshot_wait', { id, search: 'NEVER' }],
    ] as const) {
      const controller = new AbortController()
      const waiting = value.execute(name, args, 'owner', controller.signal)
      await Bun.sleep(20)
      controller.abort(new Error('AUDIT_CANCELLED'))
      await expect(waiting).rejects.toThrow('AUDIT_CANCELLED')
    }
    expect((await value.execute('pty_list', {})).content).toContain(id)
  })

  it('blocks realpath escapes and keeps explicitly allowed external directories', async () => {
    const directory = await workspace()
    const project = join(directory, 'project')
    const outside = join(directory, 'outside')
    await Promise.all([mkdir(project), mkdir(outside)])
    await symlink(
      outside,
      join(project, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const value = await start(
      host(project, [
        { action: 'shell', resource: '*', effect: 'allow' },
        { action: 'external_directory', resource: '*', effect: 'deny' },
      ])
    )
    await expect(value.execute('pty_spawn', { ...spawn(), workdir: 'escape' })).rejects.toThrow(
      'external_directory'
    )
    value.sessions.set('external', {
      location: { directory: project },
      permissions: [{ action: 'external_directory', resource: '*', effect: 'allow' }],
    })
    const id = idFrom(
      await value.execute('pty_spawn', { ...spawn(), workdir: outside }, 'external')
    )
    expect(
      (await value.execute('pty_wait', { id, timeoutSeconds: 5 }, 'external')).content
    ).toContain(outside)
  })

  it('keeps deadlines, snapshots, and deterministic queued exit notifications', async () => {
    const value = await start(host(process.cwd()))
    const id = idFrom(
      await value.execute('pty_spawn', {
        ...spawn('console.log("READY");setTimeout(()=>{},10000)'),
        timeoutSeconds: 1,
        notifyOnExit: true,
      })
    )
    await Bun.sleep(250)
    expect((await value.execute('pty_snapshot', { id })).content).toContain('READY')
    const result = await value.execute('pty_wait', { id, timeoutSeconds: 5 })
    expect(result.content).toContain('Status: killed')
    expect(await value.call('list', { sessionID: 'owner' })).toEqual([
      expect.objectContaining({ id, timedOut: true, exitAt: expect.any(String) }),
    ])
    await Bun.sleep(20)
    expect(value.messages).toHaveLength(1)
    expect(value.messages[0]).toMatchObject({
      id: `msg_${id}_exited`,
      sessionID: 'owner',
      delivery: 'queue',
      resume: true,
    })
    expect(await value.call('clearFinished', { sessionID: 'owner' })).toEqual({ removed: 1 })
  })

  it('rolls back registrations when setup fails', async () => {
    const value = host(process.cwd())
    value.context.command.transform = async () => {
      throw new Error('registration failed')
    }
    await expect(value.setup()).rejects.toThrow('registration failed')
    expect(value.disposed()).toBe(2)
  })

  it('does not spawn after unload while permissions are still being checked', async () => {
    const value = await start(host(process.cwd()))
    const get = value.context.agent.get
    let release = () => {}
    const blocked = new Promise<void>((done) => {
      release = done
    })
    value.context.agent.get = async (input) => {
      await blocked
      return get(input)
    }
    const spawning = value.execute('pty_spawn', spawn())
    await Bun.sleep(20)
    await cleanups[0]?.()
    release()
    await expect(spawning).rejects.toThrow(/disposed|aborted/i)
    await expect(value.execute('pty_list', {})).rejects.toThrow()
  })

  it('disposes resources if lifecycle events unexpectedly stop', async () => {
    const value = await start(host(process.cwd()))
    const id = idFrom(await value.execute('pty_spawn', spawn('setTimeout(()=>{},10000)')))
    const waiting = value.execute('pty_wait', { id })
    await Bun.sleep(20)
    value.closeEvents()
    await expect(waiting).rejects.toThrow()
    await Bun.sleep(20)
    expect(value.disposed()).toBe(3)
    await expect(value.execute('pty_list', {})).rejects.toThrow()
  })

  it('releases exit waits on cleanup and sends no stale exit notification', async () => {
    const value = await start(host(process.cwd()))
    const id = idFrom(
      await value.execute('pty_spawn', { ...spawn('setTimeout(()=>{},10000)'), notifyOnExit: true })
    )
    const waiting = value.execute('pty_wait', { id })
    await Bun.sleep(20)
    expect(await value.call('remove', { sessionID: 'owner', id })).toEqual({ success: true })
    expect((await waiting).content).toContain('Status: killed')
    await Bun.sleep(100)
    expect(value.messages).toEqual([])
  })
})

describe('snapshot disposal', () => {
  it('keeps rendered scrollback for the sidebar without changing viewport snapshots', async () => {
    const snapshot = new TerminalSnapshot(80, 3, 20)
    try {
      snapshot.write(Array.from({ length: 8 }, (_, index) => `HISTORY_${index}`).join('\r\n'))
      expect((await snapshot.getSettledState()).text).not.toContain('HISTORY_0')
      expect(await snapshot.getSettledText()).toContain('HISTORY_0')
      expect(await snapshot.getSettledText(2)).toBe('HISTORY_6\nHISTORY_7')
    } finally {
      snapshot.dispose()
    }
  })

  it('cancels indefinite snapshot waits when disposed', async () => {
    const snapshot = new TerminalSnapshot(120, 40)
    const waiting = snapshot.waitForCondition({ search: /NEVER/ })
    snapshot.dispose()
    await expect(waiting).rejects.toThrow()
  })
})
