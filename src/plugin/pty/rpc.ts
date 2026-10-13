import { Rpc } from '@opencode/plugin/rpc'
import { tool } from '@opencode-ai/plugin'

const z = tool.schema
const session = z.object({ sessionID: z.string().min(1) })
const target = session.extend({ id: z.string().min(1) })
const info = z.object({
  id: z.string(),
  title: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  workdir: z.string(),
  pid: z.number(),
  status: z.enum(['running', 'exited', 'killing', 'killed']),
  exitCode: z.number().optional(),
  notifyOnExit: z.boolean(),
  timeoutSeconds: z.number().optional(),
  timedOut: z.boolean(),
  createdAt: z.string(),
  exitAt: z.string().optional(),
  lineCount: z.number(),
})

/** Uses OpenCode's authenticated, location-scoped transport, including remote TUI clients. */
export const PTYRpc = Rpc.define({
  id: 'makcimbx.opencode-pty',
  methods: {
    list: { input: session, output: z.array(info) },
    output: { input: target, output: z.object({ text: z.string() }) },
    remove: { input: target, output: z.object({ success: z.boolean() }) },
    clearFinished: { input: session, output: z.object({ removed: z.number() }) },
  },
  events: {},
})
