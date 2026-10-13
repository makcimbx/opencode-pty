import { describe, expect, it } from 'bun:test'
import { PTYServer } from '../src/web/server/server.ts'

describe('web authentication', () => {
  it('rejects anonymous assets, API input and websocket upgrades', async () => {
    await using server = await PTYServer.createServer()
    const origin = server.server.url.origin
    for (const path of ['/', '/index.html', '/api/sessions', '/api/sessions/test/input', '/ws']) {
      const response = await fetch(
        origin + path,
        path.endsWith('/input') ? { method: 'POST', body: '{"data":"test"}' } : undefined
      )
      expect(response.status).toBe(401)
    }
    expect((await fetch(`${origin}/health`)).status).toBe(200)
    const ws = await fetch(`${origin}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    })
    expect(ws.status).toBe(401)
  })

  it('accepts bearer credentials but rejects mismatched Origin and Host', async () => {
    await using server = await PTYServer.createServer()
    const origin = server.server.url.origin
    const headers = { Authorization: `Bearer ${server.auth.token}` }
    expect((await fetch(`${origin}/api/sessions`, { headers })).status).toBe(200)
    expect(
      (
        await fetch(`${origin}/api/sessions`, {
          headers: { ...headers, Origin: 'https://audit.invalid' },
        })
      ).status
    ).toBe(403)
    expect(
      (await fetch(`${origin}/api/sessions`, { headers: { ...headers, Host: 'audit.invalid' } }))
        .status
    ).toBe(403)
  })

  it('issues one-time bootstrap links and an HttpOnly same-site cookie', async () => {
    await using server = await PTYServer.createServer()
    const url = server.createBrowserUrl()
    expect(url).not.toContain(server.auth.token)
    const response = await fetch(url, { redirect: 'manual' })
    expect(response.status).toBe(302)
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect((await fetch(url, { redirect: 'manual' })).status).toBe(401)
    expect(
      (
        await fetch(`${server.server.url.origin}/api/sessions`, {
          headers: { Cookie: cookie.split(';')[0] ?? '' },
        })
      ).status
    ).toBe(200)
  })

  it('does not accept another server credential or a forged token', async () => {
    await using first = await PTYServer.createServer()
    await using second = await PTYServer.createServer()
    for (const token of [first.auth.token, `${second.auth.token}x`, 'invalid']) {
      expect(
        (
          await fetch(`${second.server.url.origin}/api/sessions`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).status
      ).toBe(401)
    }
  })
})
