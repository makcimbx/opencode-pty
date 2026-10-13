import { Plugin } from '@opencode/plugin/tui'
import { createElement, insert, insertNode, setProp, type JSX } from '@opentui/solid'
import { createSignal, onCleanup } from 'solid-js'
import { PTYRpc } from '../plugin/pty/rpc.ts'
import type { PTYSessionInfo } from '../plugin/pty/types.ts'

function text(value: () => string) {
  const node = createElement('text')
  insert(node, value)
  return node
}

function column() {
  const node = createElement('box')
  setProp(node, 'flexDirection', 'column')
  return node
}

export function duration(session: PTYSessionInfo, now = Date.now()): string {
  const seconds = Math.max(
    0,
    Math.floor(
      ((session.exitAt ? Date.parse(session.exitAt) : now) - Date.parse(session.createdAt)) / 1000
    )
  )
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export default Plugin.define({
  id: 'makcimbx.opencode-pty',
  setup(ctx) {
    const rpc = ctx.client.rpc(PTYRpc)
    const controller = new AbortController()
    const [preferences, save] = ctx.storage.store('pty.sidebar', { initial: { collapsed: true } })
    const notify = (error: unknown) =>
      ctx.ui.toast.show({
        title: 'PTY',
        variant: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    const options = (sessionID: string) => ({
      location:
        ctx.data.session.get(sessionID)?.location ?? ctx.location ?? ctx.data.location.default(),
      signal: controller.signal,
    })

    ctx.ui.slot({
      append: 'sidebar.content',
      render({ sessionID }) {
        const [sessions, setSessions] = createSignal<PTYSessionInfo[]>([])
        const [status, setStatus] = createSignal('')
        const [now, setNow] = createSignal(Date.now())
        let loading = false
        let disposed = false
        const refresh = async () => {
          if (loading || disposed || preferences.collapsed) return
          loading = true
          try {
            const result = await rpc.list({ sessionID }, options(sessionID))
            if (!disposed) {
              setSessions(result)
              setStatus('')
            }
          } catch (error) {
            if (!disposed) setStatus(error instanceof Error ? error.message : String(error))
          } finally {
            loading = false
          }
        }
        const tick = setInterval(() => {
          setNow(Date.now())
          void refresh()
        }, 1500)
        onCleanup(() => {
          disposed = true
          clearInterval(tick)
        })
        void refresh()

        const showOutput = async (session: PTYSessionInfo) => {
          const [output, setOutput] = createSignal('Loading…')
          const dialogController = new AbortController()
          let reading = false
          const load = async () => {
            if (reading || dialogController.signal.aborted) return
            reading = true
            try {
              const result = await rpc.output(
                { sessionID, id: session.id },
                {
                  ...options(sessionID),
                  signal: AbortSignal.any([controller.signal, dialogController.signal]),
                }
              )
              if (!dialogController.signal.aborted)
                setOutput(result.text.split('\n').slice(-300).join('\n'))
            } catch (error) {
              if (!dialogController.signal.aborted) setOutput(String(error))
            } finally {
              reading = false
            }
          }
          const timer = setInterval(() => void load(), 1500)
          const close = () => {
            clearInterval(timer)
            dialogController.abort()
          }
          controller.signal.addEventListener('abort', close, { once: true })
          ctx.ui.dialog.show(
            () => {
              const box = column()
              insertNode(
                box,
                text(
                  () =>
                    `${session.title} · ${duration(sessions().find((value) => value.id === session.id) ?? session, now())}`
                )
              )
              const scroll = createElement('scrollbox')
              setProp(scroll, 'height', Math.max(6, ctx.renderer.height - 14))
              setProp(scroll, 'scrollY', true)
              setProp(scroll, 'stickyScroll', true)
              setProp(scroll, 'stickyStart', 'bottom')
              insertNode(scroll, text(output))
              insertNode(box, scroll)
              return box as unknown as JSX.Element
            },
            () => {
              close()
              controller.signal.removeEventListener('abort', close)
            }
          )
          ctx.ui.dialog.set({ size: 'large' })
          void load()
        }

        const remove = async (session: PTYSessionInfo) => {
          if (
            session.status === 'running' &&
            !(await ctx.ui.dialog.confirm({
              title: 'Remove PTY',
              message: `Kill and remove “${session.title}”?`,
            }))
          )
            return
          const result = await rpc.remove({ sessionID, id: session.id }, options(sessionID))
          if (!result.success) throw new Error('PTY session not found')
          await refresh()
        }
        const box = column()
        const header = text(() => `${preferences.collapsed ? '▸' : '▾'} PTY (${sessions().length})`)
        setProp(header, 'onMouseUp', () => {
          void save((value) => {
            value.collapsed = !value.collapsed
          })
            .then(refresh)
            .catch(notify)
        })
        insertNode(box, header)
        const body = column()
        insert(body, () => {
          if (preferences.collapsed) return []
          const rows = sessions().map((session) => {
            const row = createElement('box')
            setProp(row, 'flexDirection', 'row')
            const label = text(
              () =>
                `${session.status === 'running' ? '●' : '○'} ${session.title} · ${session.status} · ${duration(session, now())}`
            )
            setProp(label, 'flexGrow', 1)
            setProp(label, 'onMouseUp', () => {
              void showOutput(session).catch(notify)
            })
            insertNode(row, label)
            const button = text(() => ' ×')
            setProp(button, 'onMouseUp', () => {
              void remove(session).catch(notify)
            })
            insertNode(row, button)
            return row
          })
          if (status()) rows.unshift(text(status))
          if (!rows.length) rows.push(text(() => '(none)'))
          const clear = text(() => 'Clear finished')
          setProp(clear, 'onMouseUp', () => {
            void rpc.clearFinished({ sessionID }, options(sessionID)).then(refresh).catch(notify)
          })
          if (
            sessions().some((session) => session.status === 'exited' || session.status === 'killed')
          )
            rows.push(clear)
          return rows
        })
        insertNode(box, body)
        return box as unknown as JSX.Element
      },
    })
    ctx.keymap.layer(() => ({
      commands: [
        {
          id: 'pty.toggle',
          title: 'Toggle PTY sidebar',
          group: 'PTY',
          palette: true,
          slash: { name: 'pty-panel' },
          run: () =>
            save((value) => {
              value.collapsed = !value.collapsed
            }),
        },
      ],
    }))
    return () => controller.abort()
  },
})
