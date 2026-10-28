import { describe, expect, it, vi } from 'vitest'
import { ApiError, CodexApi, type Transport } from '../src/api'
import { makeClock, MemoryStore, NOW, status } from './helpers'

describe('fixed five-minute API failure cooldown', () => {
  it.each(['network', 'HTTP 503', 'HTTP 429', 'invalid JSON', 'invalid schema'])(
    'keeps consecutive %s failures at 300 seconds across reloads and endpoints', async failure => {
      const clock = makeClock(), store = new MemoryStore()
      let broken = true
      const transport = vi.fn<Transport>(async url => {
        if (broken && failure === 'network') throw new Error('offline')
        const history = url.includes('/resets?')
        return { status: broken && failure.startsWith('HTTP') ? Number(failure.slice(5)) : 200,
          headers: new Headers(), body: broken ? (failure === 'invalid JSON' ? '{broken' : {})
            : history ? { data: [], pagination: { has_more: false, next_cursor: null } } : status() }
      })
      const options = { clock, stateStore: store, cacheMs: 300_000, signal: new AbortController().signal }
      for (let attempt = 1; attempt <= 4; attempt++) {
        const api = new CodexApi(transport, options)
        await expect(api.history(new Date(NOW).toISOString())).rejects.toThrow()
        expect(transport).toHaveBeenCalledTimes(attempt)
        expect(store.requestState).toMatchObject({ failures: attempt, blockedUntil: clock.now() + 300_000, requestPending: false })
        clock.advance(299_999)
        await expect(api.status()).rejects.toBeInstanceOf(ApiError)
        await expect(api.recent()).rejects.toBeInstanceOf(ApiError)
        expect(transport).toHaveBeenCalledTimes(attempt)
        clock.advance(1)
      }
      broken = false
      const recovered = new CodexApi(transport, options)
      await expect(recovered.status()).resolves.toEqual(status())
      expect(store.requestState).toMatchObject({ failures: 0, blockedUntil: 0 })
      clock.advance(299_999)
      await recovered.status()
      expect(transport).toHaveBeenCalledTimes(5)
      clock.advance(1)
      await recovered.status()
      expect(transport).toHaveBeenCalledTimes(6)
    },
  )

  it.each(['0', '60', '300', '600', 'invalid', new Date(NOW + 900_000).toUTCString()])(
    'respects Retry-After %s without shortening the fixed cooldown', async retryAfter => {
      const clock = makeClock()
      const transport = vi.fn<Transport>(async () => ({ status: 503, headers: new Headers({ 'Retry-After': retryAfter }), body: {} }))
      const api = new CodexApi(transport, { clock, cacheMs: 300_000, signal: new AbortController().signal })
      await expect(api.status()).rejects.toBeInstanceOf(ApiError)
      const expected = retryAfter === '600' ? 600_000 : retryAfter.includes('GMT') ? 900_000 : 300_000
      expect(api.retryAt - clock.now()).toBe(expected)
    },
  )
})
