import { afterEach, describe, expect, it } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// This test ensures the npm package can be packed, installed, and serves assets correctly

async function run(cmd: string[], opts: { cwd?: string } = {}) {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, 90000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (timedOut) throw new Error(`${cmd.join(' ')} timed out: ${stderr}`)
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

function findPackFileFromOutput(stdout: string): string {
  const lines = stdout.trim().split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line?.trim().endsWith('.tgz')) return line.trim()
  }
  throw new Error('No .tgz file found in npm pack output')
}

describe('npm pack integration', () => {
  let tempDir: string
  let packFile: string | null = null
  let serverProcess: ReturnType<typeof Bun.spawn> | null = null
  let baseURL = ''

  afterEach(async () => {
    // Cleanup server process
    if (serverProcess) {
      serverProcess.kill()
      await serverProcess.exited
      serverProcess = null
    }

    // Cleanup temp directory
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'AbortError') {
          throw error
        }
      }
    }

    // Cleanup pack file
    if (packFile) {
      rmSync(join(process.cwd(), packFile), { force: true })
    }
  })

  it('packs, installs, and serves assets correctly', async () => {
    // 1) Create temp workspace
    tempDir = mkdtempSync(join(tmpdir(), 'opencode-pty-'))
    // Test the versions installed for this checkout, rather than resolving newer
    // SDK/TUI versions from broad published ranges on every smoke test.
    const manifest = await Bun.file(join(process.cwd(), 'package.json')).json()
    const overrides = Object.fromEntries(
      await Promise.all(
        Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).map(
          async (name) => {
            const installed = await Bun.file(
              join(process.cwd(), 'node_modules', name, 'package.json')
            ).json()
            return [name, installed.version]
          }
        )
      )
    )
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ private: true, overrides }))

    // 2) Pack the package
    const pack = await run(['npm', 'pack'])
    expect(pack.code).toBe(0)
    const tgz = findPackFileFromOutput(pack.stdout)
    packFile = tgz
    const tgzPath = join(process.cwd(), tgz)

    // List tarball contents to find an asset
    const list = await run(['tar', '-tf', tgzPath])
    expect(list.code).toBe(0)
    const files = list.stdout.split(/\r?\n/).filter(Boolean)
    const jsAsset = files.find((f) => /package\/dist\/web\/assets\/[^/]+\.js$/.test(f))
    expect(jsAsset).toBeDefined()
    const assetName = jsAsset?.replace('package/dist/web/assets/', '')

    // 3) Install in temp workspace
    const install = await run(['bun', 'install', tgzPath], { cwd: tempDir })
    expect(install.code).toBe(0)

    // Copy the server script to tempDir
    mkdirSync(join(tempDir, 'test'))
    copyFileSync(
      join(process.cwd(), 'test/start-server.ts'),
      join(tempDir, 'test', 'start-server.ts')
    )

    // Verify the package structure (compiled JS shipped in dist/)
    const packageDir = join(tempDir, 'node_modules/@makcimbx/opencode-pty')
    expect(existsSync(join(packageDir, 'dist/src/plugin/pty/manager.js'))).toBe(true)
    expect(existsSync(join(packageDir, 'dist/web/index.html'))).toBe(true)
    const portFile = join(tempDir, 'test-server.json')
    if (await Bun.file(portFile).exists()) {
      await Bun.file(portFile).delete()
    }
    serverProcess = Bun.spawn(['bun', 'run', 'test/start-server.ts'], {
      cwd: tempDir,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        CREATE_TEST_SESSION: 'false',
        TEST_SERVER_FILE: portFile,
      },
      stdout: 'inherit',
      stderr: 'inherit',
    })

    const deadline = Date.now() + 15000
    while (!(await Bun.file(portFile).exists())) {
      if (serverProcess.exitCode !== null || Date.now() >= deadline)
        throw new Error('Packed server startup failed')
      await Bun.sleep(100)
    }
    const credentials = (await Bun.file(portFile).json()) as { baseURL: string; token: string }
    baseURL = credentials.baseURL
    const headers = { Authorization: `Bearer ${credentials.token}` }

    // Wait for server to be ready
    let retries = 20 // 10 seconds
    while (retries > 0) {
      try {
        const response = await fetch(`${baseURL}/api/sessions`, { headers })
        if (response.ok) break
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'AbortError') {
          throw error
        }
      }
      await new Promise(setImmediate)
      retries--
    }
    expect(retries).toBeGreaterThan(0) // Server should be ready

    // 5) Fetch assets
    const assetResponse = await fetch(`${baseURL}/assets/${assetName}`, { headers })
    expect(assetResponse.status).toBe(200)
    // Could add more specific checks here, like content-type or specific assets

    // 6) Fetch index.html and verify it's the built version
    const indexResponse = await fetch(`${baseURL}/`, { headers })
    expect(indexResponse.status).toBe(200)
    const indexContent = await indexResponse.text()
    expect(indexContent).not.toContain('main.tsx') // Fails if raw HTML is served
    expect(indexContent).toContain('/assets/') // Confirms built assets are referenced
  }, 180000)
})
