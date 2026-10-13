import { describe, expect, it } from 'bun:test'
import { createElement, insert, testRender, type JSX } from '@opentui/solid'
import { createSignal } from 'solid-js'
import { createStore } from 'solid-js/store'
import plugin, { duration } from '../src/tui/index.ts'
import type { PTYSessionInfo } from '../src/plugin/pty/types.ts'

const finished: PTYSessionInfo = {
  id: 'pty_tui',
  title: 'TUI regression',
  command: 'bun',
  args: [],
  workdir: process.cwd(),
  status: 'exited',
  pid: 1,
  createdAt: '2026-10-13T10:00:00Z',
  exitAt: '2026-10-13T10:00:12Z',
  lineCount: 1,
  notifyOnExit: false,
  timedOut: false,
}

describe('Native V2 TUI sidebar', () => {
  it('freezes duration when the process exits', () => {
    expect(duration(finished, Date.parse('2026-10-13T12:00:00Z'))).toBe('0m 12s')
    expect(duration({ ...finished, exitAt: undefined }, Date.parse('2026-10-13T10:01:05Z'))).toBe(
      '1m 5s'
    )
  })

  it('renders real OpenTUI rows and output through location-scoped RPC', async () => {
    let slot: ((args: { sessionID: string }) => JSX.Element) | undefined
    const [preferences, update] = createStore({ collapsed: false })
    const [dialog, showDialog] = createSignal<(() => JSX.Element) | undefined>()
    let closeDialog = () => {}
    const calls: Array<{ sessionID: string; location: unknown }> = []
    const errors: unknown[] = []
    const sessionLocation = { directory: process.cwd() }
    const ctx = {
      renderer: { height: 24 },
      client: {
        rpc: () => ({
          list: async ({ sessionID }: { sessionID: string }, options: { location: unknown }) => {
            calls.push({ sessionID, location: options.location })
            return [finished]
          },
          output: async () => ({ text: 'PTY_TUI_OUTPUT_OK' }),
          remove: async () => ({ success: true }),
          clearFinished: async () => ({ removed: 1 }),
        }),
      },
      storage: {
        store: () => [
          preferences,
          async (change: (value: { collapsed: boolean }) => void) => {
            update((value) => {
              const next = { ...value }
              change(next)
              return next
            })
          },
        ],
      },
      data: {
        session: { get: () => ({ location: sessionLocation }) },
        location: { default: () => sessionLocation },
      },
      ui: {
        slot: ({ render }: { render: typeof slot }) => {
          slot = render
        },
        toast: { show: (error: unknown) => errors.push(error) },
        dialog: {
          show: (render: () => JSX.Element, onClose: () => void) => {
            closeDialog = onClose
            showDialog(() => render)
          },
          set: () => {},
          confirm: async () => true,
        },
      },
      keymap: { layer: () => {} },
    } as unknown as Parameters<typeof plugin.setup>[0]
    const stop = await plugin.setup(ctx)
    const setup = await testRender(
      () => {
        if (!slot) throw new Error('Sidebar slot was not registered')
        const root = createElement('box')
        insert(root, slot({ sessionID: 'owner' }))
        insert(root, () => dialog()?.())
        return root as unknown as JSX.Element
      },
      { width: 100, height: 24 }
    )
    try {
      await Bun.sleep(30)
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain('TUI regression')
      expect(frame).toContain('0m 12s')
      expect(frame).toContain('Clear finished')
      expect(calls).toEqual([{ sessionID: 'owner', location: sessionLocation }])
      const row = frame.split('\n').findIndex((line) => line.includes('TUI regression'))
      await setup.mockMouse.click(3, row)
      await Bun.sleep(30)
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('PTY_TUI_OUTPUT_OK')
      expect(errors).toEqual([])
    } finally {
      closeDialog()
      setup.renderer.destroy()
      if (typeof stop === 'function') await stop()
    }
  })
})
