import { describe, expect, it, vi } from 'vitest'
import { ApiError, CodexApi } from '../src/api'
import type { Transport } from '../src/api'
import { formatOverview, formatTime } from '../src/format'
import { locales } from '../src/locales'
import type { Reset, ResetListResponse } from '../src/types'
import { makeClock, NOW, reset, status } from './helpers'

const original = reset({ id: '2114588174249071102', announced_at: new Date(NOW - 7200_000).toISOString(), source: { type: 'x_post' } })
const observed = reset({ ...original, id: `observed-${original.id}`, announced_at: new Date(NOW - 3600_000).toISOString(), source: { type: 'observed' } })
const second = reset({ id: '200', announced_at: new Date(NOW - 10800_000).toISOString() })
const third = reset({ id: '100', announced_at: new Date(NOW - 14400_000).toISOString() })
const page = (data: Reset[], next_cursor: string | null = null): ResetListResponse => ({ data, pagination: { has_more: next_cursor !== null, next_cursor } })

function setup(pages = [page([observed, original, second], 'next'), page([third])]) {
  const clock = makeClock()
  const transport = vi.fn<Transport>(async url => {
    const parsed = new URL(url)
    const body = parsed.pathname.endsWith('/status') ? status({ latest_reset: observed })
      : pages[parsed.searchParams.has('cursor') ? 1 : 0]!
    return { status: 200, headers: new Headers(), body }
  })
  const api = new CodexApi(transport, { clock, cacheMs: 300_000, signal: new AbortController().signal })
  return { api, transport, clock }
}

describe('recent history counts distinct execution events', () => {
  it('fills three distinct events across pages, coalesces callers and caches the complete result for 300 seconds', async () => {
    const { api, transport, clock } = setup()
    await api.status()
    const values = await Promise.all([api.recent(), api.recent(), api.recent()])
    expect(values.map(value => value.data)).toEqual(Array(3).fill([observed, second, third]))
    expect(transport).toHaveBeenCalledTimes(3)
    expect(clock.delays).toEqual([5000, 5000])
    expect(transport.mock.calls.slice(1).map(([url]) => Object.fromEntries(new URL(url).searchParams))).toEqual([
      { limit: '3', order: 'desc' }, { limit: '3', order: 'desc', cursor: 'next' },
    ])
    clock.advance(299_999)
    await api.recent()
    expect(transport).toHaveBeenCalledTimes(3)
    clock.advance(1)
    await api.recent()
    expect(transport).toHaveBeenCalledTimes(5)
  })

  it('stops immediately when three different events are already present', async () => {
    const { api, transport } = setup([page([observed, second, third], 'older')])
    expect((await api.recent()).data).toEqual([observed, second, third])
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('returns fewer events when history is exhausted, without replaying the duplicate', async () => {
    const { api, transport } = setup([page([original, observed])])
    expect((await api.recent()).data).toEqual([observed])
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it.each([429, 503])('does not cache partial results after a later page returns HTTP %i', async code => {
    const { api, transport, clock } = setup()
    const originalTransport = transport.getMockImplementation()!
    let broken = true
    transport.mockImplementation(async (...args) => {
      if (broken && new URL(args[0]).searchParams.has('cursor')) {
        return { status: code, headers: new Headers({ 'Retry-After': '600' }), body: { detail: 'Unavailable' } }
      }
      return originalTransport(...args)
    })
    await expect(api.recent()).rejects.toBeInstanceOf(ApiError)
    expect(api.retryAt).toBe(clock.now() + 600_000)
    await expect(api.recent()).rejects.toBeInstanceOf(ApiError)
    await expect(api.history(new Date(NOW).toISOString())).rejects.toBeInstanceOf(ApiError)
    expect(transport).toHaveBeenCalledTimes(2)
    broken = false
    clock.advance(600_000)
    expect((await api.recent()).data).toEqual([observed, second, third])
    expect(transport).toHaveBeenCalledTimes(4)
    expect(new URL(transport.mock.calls[2]![0]).searchParams.has('cursor')).toBe(false)
  })

  it.each(['repeated cursor', 'too many pages'])('bounds requests on %s and rejects the incomplete result', async mode => {
    const { api, transport, clock } = setup()
    let calls = 0
    transport.mockImplementation(async () => ({ status: 200, headers: new Headers(), body: page([original, observed],
      mode === 'repeated cursor' ? 'same' : `page-${++calls}`) }))
    await expect(api.recent()).rejects.toThrow('分页异常')
    const count = mode === 'repeated cursor' ? 2 : 20
    expect(transport).toHaveBeenCalledTimes(count)
    expect(api.retryAt).toBe(clock.now() + 300_000)
    await expect(api.recent()).rejects.toBeInstanceOf(ApiError)
    expect(transport).toHaveBeenCalledTimes(count)
    expect(clock.delays.every(delay => delay === 5000)).toBe(true)
  })

  it.each(['type', 'source', 'id'] as const)('retains events differing in %s instead of collapsing them by prefix', async difference => {
    const other = difference === 'type' ? { ...observed, reset_type: 'banked' as const }
      : difference === 'source' ? { ...observed, source: { type: 'x_post' as const } }
      : { ...observed, id: 'observed-999' }
    const { api, transport } = setup([page([other, original, second])])
    expect((await api.recent()).data).toEqual([other, original, second])
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('does not shorten a concurrent Retry-After when a broken history cursor is detected', async () => {
    const { api, transport, clock } = setup()
    let otherRequest: Promise<unknown> | undefined
    transport.mockImplementation(async url => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/status')) {
        return { status: 429, headers: new Headers({ 'Retry-After': '3600' }), body: {} }
      }
      if (parsed.searchParams.has('cursor')) otherRequest = api.status().catch(error => error)
      return { status: 200, headers: new Headers(), body: page([original, observed], 'same') }
    })
    await expect(api.recent()).rejects.toThrow('分页异常')
    expect(await otherRequest).toBeInstanceOf(ApiError)
    expect(api.retryAt).toBe(clock.now() + 3600_000)
    expect(transport).toHaveBeenCalledTimes(3)
  })

  it.each(locales)('renders each linked event once in %s, using its newest available record time', locale => {
    const output = formatOverview(status({ latest_reset: observed }), [original, observed, second, third], locale, NOW, locale)
    const lines = output.split('\n').filter(line => /^\d\. /.test(line))
    expect(lines).toHaveLength(3)
    for (const [index, record] of [observed, second, third].entries()) {
      expect(lines[index]).toContain(formatTime(record.announced_at, locale, false))
    }
    expect(output).not.toContain(formatTime(original.announced_at, locale, false))
  })
})
