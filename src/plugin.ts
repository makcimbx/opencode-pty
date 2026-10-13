import type { PluginContext, PluginResult } from './plugin/types.ts'
import { PTYManager } from './plugin/pty/manager.ts'
import { createLegacyPermissionChecks } from './plugin/pty/permissions.ts'
import { ptyRuntime, type PTYRuntime } from './plugin/pty/runtime.ts'
import { ptyTools } from './plugin/pty/tools/index.ts'
import { PTYServer } from './web/server/server.ts'
import open from 'open'

const ptyOpenClientCommand = 'pty-open-background-spy'
const ptyShowServerUrlCommand = 'pty-show-server-url'

export const PTYPlugin = async ({ client, directory }: PluginContext): Promise<PluginResult> => {
  const manager = new PTYManager()
  manager.init(client)
  const runtime: PTYRuntime = {
    manager,
    directory,
    permissions: createLegacyPermissionChecks(client, directory),
  }
  let serverPromise: Promise<PTYServer> | undefined
  const getServer = () => {
    serverPromise ??= PTYServer.createServer({ runtime }).catch((error) => {
      serverPromise = undefined
      throw error
    })
    return serverPromise
  }

  return {
    'command.execute.before': async (input, output) => {
      if (input.command !== ptyOpenClientCommand && input.command !== ptyShowServerUrlCommand) {
        return
      }

      output.parts.length = 0
      const ptyServer = await getServer()
      if (input.command === ptyOpenClientCommand) {
        await open(ptyServer.createBrowserUrl())
      } else if (input.command === ptyShowServerUrlCommand) {
        const message = `PTY Sessions Web Interface URL (single-use, expires in 30s): ${ptyServer.createBrowserUrl()}`
        await client.session.prompt({
          path: { id: input.sessionID },
          body: {
            noReply: true,
            parts: [
              {
                type: 'text',
                text: message,
              },
            ],
          },
        })
      }
    },
    tool: Object.fromEntries(
      Object.entries(ptyTools).map(([name, definition]) => [
        name,
        {
          ...definition,
          execute: (args, context) =>
            ptyRuntime.run(
              {
                ...runtime,
                directory: context.directory,
                sessionID: context.sessionID,
                agent: context.agent,
                signal: context.abort,
              },
              () => definition.execute(args as never, context)
            ),
        },
      ])
    ),
    config: async (input) => {
      if (!input.command) {
        input.command = {}
      }
      input.command[ptyOpenClientCommand] = {
        template: `This command will start the PTY Sessions Web Interface in your default browser.`,
        description: 'Open PTY Sessions Web Interface',
      }
      input.command[ptyShowServerUrlCommand] = {
        template: `This command will show the PTY Sessions Web Interface URL.`,
        description: 'Show PTY Sessions Web Interface URL',
      }
    },
    event: async ({ event }) => {
      if (event.type === 'session.deleted') {
        manager.cleanupBySession(event.properties.info.id)
      }
    },
  }
}
