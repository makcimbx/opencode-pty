import { tool } from '@opencode-ai/plugin'
import { getManager } from '../manager.ts'
import { MAX_LINE_LENGTH } from '../../../shared/constants.ts'
import { buildSessionNotFoundError } from '../utils.ts'
import { formatLine } from '../formatters.ts'
import type { PTYSessionInfo } from '../types.ts'
import DESCRIPTION from './wait.txt'

const WAIT_TAIL_LINES = 20
const TIMEOUT = Symbol('pty_wait_timeout')

function isTerminal(session: PTYSessionInfo): boolean {
  return session.status === 'exited' || session.status === 'killed'
}

/**
 * Reads the tail of a session's buffer as formatted lines.
 */
function formatTail(session: PTYSessionInfo, count: number): string[] {
  const offset = Math.max(0, session.lineCount - count)
  const result = getManager().read(session.id, offset, count)
  if (!result || result.lines.length === 0) {
    return []
  }
  return result.lines.map((line, index) =>
    formatLine(line, result.offset + index + 1, MAX_LINE_LENGTH)
  )
}

function formatWaitedBlock(session: PTYSessionInfo): string {
  const tail = formatTail(session, WAIT_TAIL_LINES)
  const exitInfo = `${session.exitCode ?? 'unknown'}${session.exitSignal ? `, signal: ${session.exitSignal}` : ''}`
  return [
    `<pty_waited>`,
    `ID: ${session.id}`,
    `Title: ${session.title}`,
    `Command: ${session.command} ${session.args.join(' ')}`,
    `Status: ${session.status}`,
    `Exit: ${exitInfo}`,
    `Output Lines: ${session.lineCount}`,
    ...(tail.length > 0 ? ['', 'Tail:', ...tail] : []),
    `</pty_waited>`,
  ].join('\n')
}

export const ptyWait = tool({
  description: DESCRIPTION,
  args: {
    id: tool.schema.string().describe('The PTY session ID (e.g., pty_a1b2c3d4)'),
    timeoutSeconds: tool.schema
      .number()
      .optional()
      .describe(
        'Maximum time to wait in seconds. If the session is still running after this, returns a <pty_wait_timeout> result instead of blocking forever. Default: no limit.'
      ),
  },
  async execute(args, context) {
    const manager = getManager()
    const signal = context?.abort
    signal?.throwIfAborted()
    const initial = manager.get(args.id)
    if (!initial) {
      throw buildSessionNotFoundError(args.id)
    }
    if (isTerminal(initial)) {
      return formatWaitedBlock(initial)
    }

    let resolveDone!: (session: PTYSessionInfo) => void
    const done = new Promise<PTYSessionInfo>((resolve) => {
      resolveDone = resolve
    })

    const onUpdate = (updated: PTYSessionInfo): void => {
      if (updated.id !== args.id || !isTerminal(updated)) {
        return
      }
      resolveDone(updated)
    }
    manager.sessionUpdateCallbacks.push(onUpdate)

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      // Close the race window between the initial get and registration.
      const recheck = manager.get(args.id)
      if (!recheck) {
        throw buildSessionNotFoundError(args.id)
      }
      if (isTerminal(recheck)) {
        resolveDone(recheck)
      }

      const timeoutSeconds = args.timeoutSeconds
      let timeout: Promise<typeof TIMEOUT>
      if (timeoutSeconds === undefined) {
        timeout = new Promise<typeof TIMEOUT>(() => {})
      } else {
        timeout = new Promise<typeof TIMEOUT>((resolve) => {
          timeoutHandle = setTimeout(
            () => {
              resolve(TIMEOUT)
            },
            Math.max(0, Math.floor(timeoutSeconds * 1000))
          )
        })
      }

      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) onAbort()
      })
      const winner = await Promise.race([done, timeout, aborted])
      if (winner === TIMEOUT) {
        return [
          `<pty_wait_timeout>`,
          `Session is still running after ${Math.max(0, args.timeoutSeconds ?? 0)}s.`,
          `Use pty_read for live output, pty_kill to stop it, or call pty_wait again with a longer timeout.`,
          `</pty_wait_timeout>`,
        ].join('\n')
      }
      return formatWaitedBlock(winner)
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      const index = manager.sessionUpdateCallbacks.indexOf(onUpdate)
      if (index !== -1) manager.sessionUpdateCallbacks.splice(index, 1)
    }
  },
})
