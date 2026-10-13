// Run Playwright under Node: Bun's Windows browser-process transport can hang.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, firefox } from 'playwright'

const directory = await mkdtemp(join(tmpdir(), 'pty-browser-smoke-'))
const credentialsFile = join(directory, 'server.json')
const server = spawn(process.env.BUN_EXECUTABLE ?? 'bun', ['run', 'test/e2e/test-web-server.ts'], {
  env: { ...process.env, NODE_ENV: 'test', TEST_SERVER_FILE: credentialsFile },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
server.stdout.on('data', (data) => {
  logs += data
})
server.stderr.on('data', (data) => {
  logs += data
})
let startupError
server.on('error', (error) => {
  startupError = error
})
try {
  let credentials
  const deadline = Date.now() + 15000
  while (!credentials) {
    if (startupError) throw startupError
    if (server.exitCode !== null || Date.now() >= deadline)
      throw new Error(`Server failed to start: ${logs}`)
    try {
      credentials = JSON.parse(await readFile(credentialsFile, 'utf8'))
    } catch {
      await sleep(100)
    }
  }
  const { baseURL, token, cookieName } = credentials
  assert.equal((await fetch(baseURL)).status, 401)
  const headers = { Authorization: `Bearer ${token}` }
  const created = await fetch(`${baseURL}/api/sessions`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: process.env.BUN_EXECUTABLE ?? 'bun',
      args: ['-e', 'console.log("PTY_BROWSER_SMOKE_OK");setTimeout(()=>{},20000)'],
      description: 'Browser smoke',
      timeoutSeconds: 25,
    }),
  })
  assert.equal(created.status, 200, await created.clone().text())
  for (const browserType of [chromium, firefox]) {
    const browser = await browserType.launch({ timeout: 15000 })
    try {
      const context = await browser.newContext()
      await context.addCookies([
        { name: cookieName, value: token, url: baseURL, httpOnly: true, sameSite: 'Strict' },
      ])
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      const sockets = []
      page.on('websocket', (socket) => sockets.push(socket))
      await page.goto(baseURL, { timeout: 15000 })
      await page.getByText('Browser smoke', { exact: true }).first().waitFor({ timeout: 10000 })
      await page
        .locator('.xterm-screen')
        .getByText('PTY_BROWSER_SMOKE_OK', { exact: false })
        .waitFor({ timeout: 10000 })
      assert.ok(sockets.length > 0, 'Browser WebSocket did not connect')
      assert.deepEqual(errors, [])
      console.log(`${browserType.name()}: authenticated HTTP, cookie WebSocket, PTY output OK`)
    } finally {
      await browser.close()
    }
  }
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve))
    server.kill()
    await exited
  }
  await rm(directory, { recursive: true, force: true })
}
