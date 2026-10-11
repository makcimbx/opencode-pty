import type { Plugin } from '@opencode/plugin'
import { tool, type ToolContext, type ToolDefinition } from '@opencode-ai/plugin'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import open from 'open'
import { initManager, manager } from './pty/manager.ts'
import { initPermissionChecks } from './pty/permissions.ts'
import { ptyTools } from './pty/tools/index.ts'
import { match } from './pty/wildcard.ts'
import type { SessionClient } from './types.ts'
import { PTYServer } from '../web/server/server.ts'

type ExecutionContext = { sessionID: string; agent: string }
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
    const execution = new AsyncLocalStorage<ExecutionContext>()
    const controller = new AbortController()
    let ptyServer: PTYServer | undefined
    let serverPromise: Promise<PTYServer> | undefined

    const getServer = () => {
      serverPromise ??= PTYServer.createServer()
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
      const current = execution.getStore()
      // Web UI requests have no agent tool context; use the build agent's rules.
      const agent = await ctx.agent.get({
        agentID: current?.agent ?? 'build',
        location: { directory: ctx.location.directory },
      })
      const session = current ? await ctx.session.get({ sessionID: current.sessionID }) : undefined
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

    initPermissionChecks({
      command: (command, args) => check('shell', [command, ...args].join(' ')),
      async workdir(workdir) {
        const path = resolve(ctx.location.directory, workdir)
        const subpath = relative(ctx.location.directory, path)
        if (subpath === '..' || subpath.startsWith(`..${sep}`) || isAbsolute(subpath)) {
          await check('external_directory', `${path}${sep}*`)
        }
      },
    })
    initManager(createSessionClient(ctx))

    await ctx.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(ptyTools) as [string, ToolDefinition][]) {
        const input = tool.schema.object(definition.args)
        editor.add({
          name,
          description: definition.description,
          input,
          async execute(args, context) {
            const legacyContext: ToolContext = {
              sessionID: context.sessionID,
              messageID: context.messageID,
              agent: context.agent,
              directory: ctx.location.directory,
              worktree: ctx.location.directory,
              abort: context.signal,
              metadata: (metadata) => {
                void context.progress(metadata)
              },
              ask: async () => {
                throw new Error('PTY permission prompts are not supported')
              },
            }
            const parsed = input.parse(args)
            if (name === 'pty_spawn') {
              parsed.workdir = resolve(
                ctx.location.directory,
                typeof parsed.workdir === 'string' ? parsed.workdir : '.'
              )
            }
            return execution.run(context, async () => ({
              content: await definition.execute(parsed, legacyContext),
            }))
          },
        })
      }
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: 'pty-open-background-spy',
        description: 'Open PTY Sessions Web Interface',
        async execute() {
          const server = await getServer()
          await open(server.server.url.origin)
        },
      })
      editor.add({
        name: 'pty-show-server-url',
        description: 'Show PTY Sessions Web Interface URL',
        async execute({ sessionID }) {
          const server = await getServer()
          await ctx.session.synthetic({
            sessionID,
            text: `PTY Sessions Web Interface URL: ${server.server.url.origin}`,
            resume: false,
          })
        },
      })
    })

    const events = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === 'session.deleted') manager.cleanupBySession(event.data.sessionID)
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error('PTY event subscription failed', error)
      }
    })()

    return async () => {
      controller.abort()
      manager.clearAllSessions()
      // A command may still be starting the server when the plugin is unloaded.
      await serverPromise?.catch(() => undefined)
      ptyServer?.[Symbol.dispose]()
      await events
    }
  },
} satisfies Plugin.Plugin
