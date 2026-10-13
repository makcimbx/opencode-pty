import type { Plugin } from '@opencode/plugin'
import { tool, type ToolContext, type ToolDefinition } from '@opencode-ai/plugin'
import { resolve, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import open from 'open'
import { PTYManager } from './pty/manager.ts'
import { isProjectDirectory } from './pty/permissions.ts'
import { currentRuntime, ptyRuntime, type PTYRuntime } from './pty/runtime.ts'
import { ptyTools } from './pty/tools/index.ts'
import { match } from './pty/wildcard.ts'
import type { SessionClient } from './types.ts'
import { PTYServer } from '../web/server/server.ts'
import { PTYRpc } from './pty/rpc.ts'

type PermissionRule = { action: string; resource: string; effect: 'allow' | 'ask' | 'deny' }

export function createSessionClient(ctx: Plugin.Context): SessionClient {
  return {
    session: {
      async get({ path }) {
        return { data: await ctx.session.get({ sessionID: path.id }) }
      },
      async promptAsync({ path, body }) {
        // Synthetic admission keeps the session's current agent, model and variant.
        // Unlike a user prompt, it does not switch the session or run prompt hooks.
        return ctx.session.synthetic({
          sessionID: path.id,
          id: body.messageID,
          text: body.parts.map((part) => part.text).join('\n'),
          delivery: 'queue',
          resume: true,
        })
      },
    },
  }
}

export const PTYPluginV2 = {
  id: 'makcimbx.opencode-pty',
  async setup(ctx) {
    const manager = new PTYManager()
    manager.init(createSessionClient(ctx))
    const controller = new AbortController()
    const registrations: Array<{ dispose(): Promise<void> }> = []
    let ptyServer: PTYServer | undefined
    let serverPromise: Promise<PTYServer> | undefined

    const getServer = () => {
      controller.signal.throwIfAborted()
      serverPromise ??= PTYServer.createServer({ runtime })
        .then((server) => {
          ptyServer = server
          return server
        })
        .catch((error) => {
          serverPromise = undefined
          throw error
        })
      return serverPromise
    }

    async function rules(): Promise<readonly PermissionRule[]> {
      const current = currentRuntime()
      // Web UI requests have no agent tool context; use the build agent's rules.
      const agent = await ctx.agent.get({
        agentID: current?.agent ?? 'build',
        location: { directory: current?.directory ?? ctx.location.directory },
      })
      const session = current?.sessionID
        ? await ctx.session.get({ sessionID: current.sessionID })
        : undefined
      return [...agent.data.permissions, ...(session?.permissions ?? [])]
    }

    async function check(action: string, resource: string): Promise<void> {
      let effect: PermissionRule['effect'] = 'ask'
      for (const rule of await rules()) {
        let pattern = rule.resource
        let value = resource
        if (action === 'external_directory') {
          pattern = pattern.replaceAll('\\', '/')
          value = value.replaceAll('\\', '/')
          if (process.platform === 'win32') {
            pattern = pattern.toLowerCase()
            value = value.toLowerCase()
          }
        }
        const resourceMatches =
          match(value, pattern) ||
          (action === 'shell' && pattern.endsWith(' *') && match(value, pattern.slice(0, -2)))
        if (match(action, rule.action) && resourceMatches) effect = rule.effect
      }
      if (effect !== 'allow') {
        throw new Error(
          `PTY spawn denied: ${action} "${resource}" ${effect === 'ask' ? 'requires user permission (treated as denied)' : 'is denied by user configuration'}.`
        )
      }
    }

    const runtime: PTYRuntime = {
      manager,
      directory: ctx.location.directory,
      signal: controller.signal,
      permissions: {
        command: (command, args) => check('shell', [command, ...args].join(' ')),
        async workdir(workdir) {
          const directory = currentRuntime()?.directory ?? ctx.location.directory
          if (!(await isProjectDirectory(directory, workdir))) {
            const path = await realpath(resolve(directory, workdir))
            await check('external_directory', `${path}${sep}*`)
          }
        },
      },
    }

    let cleanupPromise: Promise<void> | undefined
    const cleanup = () => {
      cleanupPromise ??= (async () => {
        controller.abort()
        manager.dispose()
        await serverPromise?.catch(() => undefined)
        ptyServer?.[Symbol.dispose]()
        await Promise.allSettled(
          registrations
            .splice(0)
            .reverse()
            .map((value) => value.dispose())
        )
      })()
      return cleanupPromise
    }

    try {
      const scope = <T>(sessionID: string, signal: AbortSignal, action: () => T) => {
        controller.signal.throwIfAborted()
        signal.throwIfAborted()
        return ptyRuntime.run({ ...runtime, sessionID }, action)
      }
      registrations.push(
        await ctx.rpc.register(PTYRpc, {
          list: async (input, context) =>
            scope(input.sessionID, context.signal, () => manager.list()),
          output: async (input, context) =>
            scope(input.sessionID, context.signal, async () => {
              const text = await manager.snapshotText(input.id)
              if (text === null) throw new Error('PTY session not found')
              return { text }
            }),
          remove: async (input, context) =>
            scope(input.sessionID, context.signal, () => ({
              success: manager.kill(input.id, true),
            })),
          clearFinished: async (input, context) =>
            scope(input.sessionID, context.signal, () => ({
              removed: manager
                .list()
                .filter((session) => session.status === 'exited' || session.status === 'killed')
                .filter((session) => manager.kill(session.id, true)).length,
            })),
        })
      )

      registrations.push(
        await ctx.tool.transform((editor) => {
          for (const [name, definition] of Object.entries(ptyTools) as [string, ToolDefinition][]) {
            const input = tool.schema.object(definition.args)
            editor.add({
              name,
              description: definition.description,
              input,
              async execute(args, context) {
                controller.signal.throwIfAborted()
                const session = await ctx.session.get({ sessionID: context.sessionID })
                const directory = session.location.directory
                const signal = AbortSignal.any([context.signal, controller.signal])
                signal.throwIfAborted()
                const legacyContext: ToolContext = {
                  sessionID: context.sessionID,
                  messageID: context.messageID,
                  agent: context.agent,
                  directory,
                  worktree: directory,
                  abort: signal,
                  metadata: (metadata) => {
                    void context.progress(metadata).catch(() => undefined)
                  },
                  ask: async () => {
                    throw new Error('PTY permission prompts are not supported')
                  },
                }
                const parsed = input.parse(args)
                if (name === 'pty_spawn') {
                  parsed.workdir = resolve(
                    directory,
                    typeof parsed.workdir === 'string' ? parsed.workdir : '.'
                  )
                }
                return ptyRuntime.run(
                  {
                    ...runtime,
                    directory,
                    sessionID: context.sessionID,
                    agent: context.agent,
                    signal,
                  },
                  async () => ({
                    content: await definition.execute(parsed, legacyContext),
                  })
                )
              },
            })
          }
        })
      )

      registrations.push(
        await ctx.command.transform((editor) => {
          editor.add({
            name: 'pty-open-background-spy',
            description: 'Open PTY Sessions Web Interface',
            async execute() {
              const server = await getServer()
              await open(server.createBrowserUrl())
            },
          })
          editor.add({
            name: 'pty-show-server-url',
            description: 'Show PTY Sessions Web Interface URL',
            async execute({ sessionID }) {
              const server = await getServer()
              await ctx.session.synthetic({
                sessionID,
                text: `PTY Sessions Web Interface URL (single-use, expires in 30s): ${server.createBrowserUrl()}`,
                resume: false,
              })
            },
          })
        })
      )

      const events = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (event.type === 'session.deleted') manager.cleanupBySession(event.data.sessionID)
          }
        } catch (error) {
          if (!controller.signal.aborted) console.error('PTY event subscription failed', error)
        } finally {
          // Without lifecycle events we cannot safely retain processes from deleted sessions.
          if (!controller.signal.aborted) await cleanup()
        }
      })()

      return async () => {
        await cleanup()
        await events
      }
    } catch (error) {
      await cleanup()
      throw error
    }
  },
} satisfies Plugin.Plugin
