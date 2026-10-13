import { type ChildProcess, spawn } from 'node:child_process'
import { test as base, type WorkerInfo } from '@playwright/test'

import { createApiClient } from '../../src/web/shared/api-client.ts'
import { ManagedTestClient } from '../utils'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return
    } catch {
      // ignore errors
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`Server did not become ready at ${url} within ${timeoutMs}ms`)
}

type TestFixtures = {
  api: ReturnType<typeof createApiClient>
  autoCleanup: undefined
  wsClient: ManagedTestClient
}
type WorkerFixtures = {
  server: { baseURL: string; port: number; token: string; cookieName: string }
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  server: [
    // biome-ignore lint/correctness/noEmptyPattern: required empty pattern for Playwright fixture
    async ({}, fixtureUse, workerInfo: WorkerInfo) => {
      const workerIndex = workerInfo.workerIndex
      const portFilePath = join(tmpdir(), `pty-e2e-${process.pid}-${workerIndex}.json`)

      // Clean up old port file from previous test runs
      try {
        const file = Bun.file(portFilePath)
        await file.delete()
      } catch {
        // ignore errors
      }

      const proc: ChildProcess = spawn('bun', ['run', 'test/e2e/test-web-server.ts'], {
        env: {
          ...process.env,
          TEST_WORKER_INDEX: workerInfo.workerIndex.toString(),
          TEST_SERVER_FILE: portFilePath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      proc.stdout?.on('data', (_data) => {
        console.log(`[W${workerIndex} OUT] ${_data}`)
      })

      proc.stderr?.on('data', (data) => {
        console.error(`[W${workerIndex} ERR] ${data}`)
      })

      try {
        // Wait for server to write port file
        const deadline = Date.now() + 15000
        while (!(await Bun.file(portFilePath).exists())) {
          if (proc.exitCode !== null || proc.signalCode !== null || Date.now() >= deadline)
            throw new Error('Test server startup failed')
          await Bun.sleep(100)
        }
        const { baseURL, token, cookieName } = (await Bun.file(
          portFilePath
        ).json()) as WorkerFixtures['server']
        const port = Number(new URL(baseURL).port)
        await waitForServer(`${baseURL}/health`, 15000)

        // Clear any leftover sessions from previous test runs
        try {
          const apiClient = createApiClient(baseURL, { Authorization: `Bearer ${token}` })
          await apiClient.sessions.clear()
        } catch (error) {
          // Ignore clear errors during startup
          console.log(`[Worker ${workerIndex}] Could not clear sessions during startup: ${error}`)
        }

        await fixtureUse({ baseURL, port, token, cookieName })
      } catch (error) {
        console.error(`[Worker ${workerIndex}] Failed to start server: ${error}`)
        throw error
      } finally {
        // Ensure process is killed
        if (proc.exitCode === null && proc.signalCode === null) {
          const exited = new Promise<void>((done) => proc.once('exit', () => done()))
          proc.kill('SIGTERM')
          const timer = setTimeout(() => {
            if (proc.exitCode === null && proc.signalCode === null) {
              proc.kill('SIGKILL')
            }
          }, 2000)
          await exited
          clearTimeout(timer)
        }
        await Bun.file(portFilePath)
          .delete()
          .catch(() => {})
      }
    },
    { scope: 'worker', auto: true },
  ],

  // Auto fixture that clears sessions before every test
  autoCleanup: [
    async ({ server }, fixtureUse) => {
      const api = createApiClient(server.baseURL, { Authorization: `Bearer ${server.token}` })
      try {
        await api.sessions.clear()
      } catch (error) {
        console.warn('Could not clear sessions before test:', error)
      }
      await fixtureUse(undefined)
    },
    { auto: true },
  ],

  api: async ({ server }, fixtureUse) => {
    const api = createApiClient(server.baseURL, { Authorization: `Bearer ${server.token}` })
    await fixtureUse(api)
  },

  // WebSocket client fixture for event-driven testing
  wsClient: async ({ server }, fixtureUse) => {
    const wsUrl = `${server.baseURL.replace(/^http/, 'ws')}/ws`
    await using client = await ManagedTestClient.create(wsUrl, server.token)
    await fixtureUse(client)
  },

  // Extend page fixture to automatically navigate to server URL and wait for readiness
  page: async ({ page, server }, fixtureUse) => {
    await page.context().addCookies([
      {
        name: server.cookieName,
        value: server.token,
        url: server.baseURL,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ])
    await page.goto(server.baseURL)
    await page.waitForLoadState('networkidle')
    await fixtureUse(page)
  },
})

export { expect } from '@playwright/test'
