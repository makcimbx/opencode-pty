import { describe, expect, it, mock } from 'bun:test'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { RingBuffer } from '../src/plugin/pty/buffer.ts'
import { NotificationManager } from '../src/plugin/pty/notification-manager.ts'
import { TerminalSnapshot } from '../src/plugin/pty/snapshot.ts'
import type { PTYSession } from '../src/plugin/pty/types.ts'

type PromptPayload = {
  path: { id: string }
  body: {
    parts: Array<{ type: string; text: string }>
    agent?: string
    model?: { providerID: string; modelID: string }
    variant?: string
  }
}

function createSession(overrides: Partial<PTYSession> = {}): PTYSession {
  const buffer = new RingBuffer()
  const snapshot = new TerminalSnapshot(120, 40)
  buffer.append('line 1\nline 2\n')

  return {
    id: 'pty_test',
    title: 'Test Session',
    description: 'Test session description',
    command: 'echo',
    args: ['hello'],
    workdir: '/tmp',
    status: 'running',
    pid: 12345,
    createdAt: new Date(),
    parentSessionId: 'parent-session-id',
    parentAgent: 'agent-two',
    notifyOnExit: true,
    timeoutSeconds: undefined,
    timedOut: false,
    buffer,
    snapshot,
    process: null,
    ...overrides,
  }
}

function createBufferSession(lines: string[], overrides: Partial<PTYSession> = {}): PTYSession {
  const buffer = new RingBuffer()
  buffer.append(lines.join('\n'))
  if (lines.length > 0) {
    buffer.append('\n')
  }

  return createSession({ buffer, ...overrides })
}

describe('NotificationManager', () => {
  it('preserves the parent session model and variant', async () => {
    const get = mock(async () => ({
      data: {
        model: { providerID: 'openai', id: 'gpt-5.6-terra', variant: 'high' },
      },
    }))
    const promptAsync = mock(async (_payload: PromptPayload) => {})
    const manager = new NotificationManager()

    manager.init({ session: { get, promptAsync } } as unknown as OpencodeClient)

    await manager.sendExitNotification(createSession(), 0)

    expect(get).toHaveBeenCalledWith({ path: { id: 'parent-session-id' } })
    const payload = promptAsync.mock.calls[0]?.[0]
    if (!payload) throw new Error('Expected a prompt payload')
    expect(payload.body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.6-terra',
    })
    expect(payload.body.variant).toBe('high')
  })

  it('preserves the parent model without inventing a variant', async () => {
    const get = mock(async () => ({
      data: { model: { providerID: 'openai', id: 'gpt-5.6-terra' } },
    }))
    const promptAsync = mock(async (_payload: PromptPayload) => {})
    const manager = new NotificationManager()

    manager.init({ session: { get, promptAsync } } as unknown as OpencodeClient)

    await manager.sendExitNotification(createSession(), 0)

    const payload = promptAsync.mock.calls[0]?.[0]
    if (!payload) throw new Error('Expected a prompt payload')
    expect(payload.body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.6-terra',
    })
    expect(Object.hasOwn(payload.body, 'variant')).toBe(false)
  })

  it('sends the notification when reading the parent model fails', async () => {
    const get = mock(async () => {
      throw new Error('Session API unavailable')
    })
    const promptAsync = mock(async (_payload: PromptPayload) => {})
    const manager = new NotificationManager()

    manager.init({ session: { get, promptAsync } } as unknown as OpencodeClient)

    await manager.sendExitNotification(createSession(), 0)

    expect(promptAsync).toHaveBeenCalledTimes(1)
    const payload = promptAsync.mock.calls[0]?.[0]
    if (!payload) throw new Error('Expected a prompt payload')
    expect(Object.hasOwn(payload.body, 'model')).toBe(false)
    expect(Object.hasOwn(payload.body, 'variant')).toBe(false)
  })

  it('includes body.agent when originating agent is present', async () => {
    const promptAsync = mock(async (_payload: PromptPayload) => {})
    const manager = new NotificationManager()

    manager.init({ session: { promptAsync } } as unknown as OpencodeClient)

    await manager.sendExitNotification(createSession({ parentAgent: 'agent-two' }), 0)

    expect(promptAsync).toHaveBeenCalledTimes(1)
    const payload = promptAsync.mock.calls[0]?.[0]
    if (!payload) throw new Error('Expected a prompt payload')

    expect(payload.path).toEqual({ id: 'parent-session-id' })
    expect(payload.body.agent).toBe('agent-two')
    expect(payload.body.parts).toHaveLength(1)
    expect(payload.body.parts[0]?.text).toContain('<pty_exited>')
    expect(payload.body.parts[0]?.text).toContain('Use pty_read to check the full output.')
  })

  it('omits body.agent when originating agent is missing', async () => {
    const promptAsync = mock(async (_payload: PromptPayload) => {})
    const manager = new NotificationManager()

    manager.init({ session: { promptAsync } } as unknown as OpencodeClient)

    await manager.sendExitNotification(createSession({ parentAgent: undefined }), 1)

    expect(promptAsync).toHaveBeenCalledTimes(1)
    const payload = promptAsync.mock.calls[0]?.[0]
    if (!payload) throw new Error('Expected a prompt payload')

    expect(payload.path).toEqual({ id: 'parent-session-id' })
    expect(Object.hasOwn(payload.body, 'agent')).toBe(false)
    expect(payload.body.parts).toHaveLength(1)
    expect(payload.body.parts[0]?.text).toContain('<pty_exited>')
    expect(payload.body.parts[0]?.text).toContain(
      'Process failed. Use pty_read with the pattern parameter to search for errors in the output.'
    )
  })

  it('includes timeout context when the session timed out', async () => {
    const promptAsync = mock(async (_payload: PromptPayload) => {})
    const manager = new NotificationManager()

    manager.init({ session: { promptAsync } } as unknown as OpencodeClient)

    await manager.sendExitNotification(createSession({ timeoutSeconds: 2, timedOut: true }), 0)

    expect(promptAsync).toHaveBeenCalledTimes(1)
    const payload = promptAsync.mock.calls[0]?.[0]
    if (!payload) throw new Error('Expected a prompt payload')
    const text = payload.body.parts[0]?.text ?? ''

    expect(text).toContain('TimeoutSeconds: 2')
    expect(text).toContain('Timed Out: yes')
    expect(text).toContain('Process reached its PTY timeout and was stopped automatically.')
  })

  it('sanitizes the last line before including it in notifications', async () => {
    const promptAsync = mock(async (_payload: PromptPayload) => {})
    const manager = new NotificationManager()

    manager.init({ session: { promptAsync } } as unknown as OpencodeClient)

    await manager.sendExitNotification(
      createBufferSession([
        'plain line',
        '\u001b[33m19:40:47 backend.1 | warning\u001b[39m\rstatus \u001b]8;;https://example.com\u0007link\u001b]8;;\u0007\u0007',
      ]),
      0
    )

    const payload = promptAsync.mock.calls[0]![0]
    const text = payload.body.parts[0]?.text ?? ''

    expect(text).toContain('Last Line: 19:40:47 backend.1 | warning status link')
    expect(text).not.toContain('\u001b')
    expect(text).not.toContain('\r')
    expect(text).not.toContain(']8;;')
  })

  it('falls back to the previous non-empty line when the trailing line sanitizes away', async () => {
    const promptAsync = mock(async (_payload: PromptPayload) => {})
    const manager = new NotificationManager()

    manager.init({ session: { promptAsync } } as unknown as OpencodeClient)

    await manager.sendExitNotification(
      createBufferSession(['still here', '\u001b[31m\u001b[0m\u0007\r\n']),
      0
    )

    const payload = promptAsync.mock.calls[0]![0]
    const text = payload.body.parts[0]?.text ?? ''

    expect(text).toContain('Last Line: still here')
    expect(text).toContain('Output Lines: 3')
  })

  it('omits the last line when no buffer line survives sanitization', async () => {
    const promptAsync = mock(async (_payload: PromptPayload) => {})
    const manager = new NotificationManager()

    manager.init({ session: { promptAsync } } as unknown as OpencodeClient)

    await manager.sendExitNotification(
      createBufferSession([
        '\u001b[31m\u001b[0m',
        '\u001b]8;;https://example.com\u0007\u001b]8;;\u0007',
      ]),
      0
    )

    const payload = promptAsync.mock.calls[0]![0]
    const text = payload.body.parts[0]?.text ?? ''

    expect(text).not.toContain('Last Line:')
    expect(text).toContain('Output Lines: 2')
  })
})
