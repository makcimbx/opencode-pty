import { OpencodeClient } from '@opencode-ai/sdk'
import { initManager } from '../../src/plugin/pty/manager.ts'
import { PTYServer } from '../../src/web/server/server.ts'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

initManager(new OpencodeClient())

const server = await PTYServer.createServer()

// Only log in non-test environments or when explicitly requested

// Write server URL to file for tests to read
if (process.env.NODE_ENV === 'test') {
  const workerIndex = process.env.TEST_WORKER_INDEX || '0'
  if (!server.server.url) {
    throw new Error('Server URL not available. File an issue if you need this feature.')
  }
  await Bun.write(
    process.env.TEST_SERVER_FILE ?? join(tmpdir(), `test-server-port-${workerIndex}.json`),
    JSON.stringify({
      baseURL: server.server.url.origin,
      token: server.auth.token,
      cookieName: server.auth.cookieName,
    })
  )
}

// Health check for test mode
if (process.env.NODE_ENV === 'test') {
  try {
    const response = await fetch(`${server.server.url.origin}/health`)
    if (!response.ok) {
      console.error('Server health check failed')
      process.exit(1)
    }
  } catch (error) {
    console.error('Server health check failed:', error)
    process.exit(1)
  }
}
