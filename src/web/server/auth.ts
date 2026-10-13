import { randomBytes, timingSafeEqual } from 'node:crypto'

/** Ephemeral credentials never appear in a persistent browser URL or discovery record. */
export class ServerAuth {
  readonly token = randomBytes(32).toString('base64url')
  readonly cookieName = `opencode_pty_${randomBytes(8).toString('hex')}`
  private readonly bootstraps = new Map<string, number>()

  authorized(request: Request): boolean {
    const bearer = request.headers.get('authorization')?.replace(/^Bearer /i, '')
    const cookie = request.headers
      .get('cookie')
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${this.cookieName}=`))
      ?.slice(this.cookieName.length + 1)
    return [bearer, cookie].some((value) => {
      if (!value) return false
      const actual = Buffer.from(value)
      const expected = Buffer.from(this.token)
      return actual.length === expected.length && timingSafeEqual(actual, expected)
    })
  }

  createBrowserUrl(origin: string): string {
    this.prune()
    // Bound abandoned links as well as their lifetime.
    const oldest = this.bootstraps.keys().next().value
    if (this.bootstraps.size >= 64 && oldest) this.bootstraps.delete(oldest)
    const nonce = randomBytes(32).toString('base64url')
    this.bootstraps.set(nonce, Date.now() + 30_000)
    return `${origin}/auth/${nonce}`
  }

  consume(nonce: string): boolean {
    const expires = this.bootstraps.get(nonce)
    this.bootstraps.delete(nonce)
    return expires !== undefined && expires > Date.now()
  }

  cookie(): string {
    return `${this.cookieName}=${this.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`
  }

  private prune(): void {
    for (const [nonce, expires] of this.bootstraps) {
      if (expires <= Date.now()) this.bootstraps.delete(nonce)
    }
  }
}
