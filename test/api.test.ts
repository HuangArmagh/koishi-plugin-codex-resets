import { describe, expect, it, vi } from 'vitest'
import { ApiError, CodexApi, parseHistory, parseStatus } from '../src/api'
import type { HttpResponse, Transport } from '../src/api'
import { makeClock, MemoryStore, reset, scheduled, status, watch } from './helpers'

function response(body: unknown = status(), code = 200, headers: Record<string, string> = {}): HttpResponse {
  return { status: code, headers: new Headers(headers), body }
}

function setup(cacheMs = 60_000) {
  const clock = makeClock()
  const controller = new AbortController()
  const transport = vi.fn<Transport>(async () => response())
  const api = new CodexApi(transport, { cacheMs, clock, signal: controller.signal })
  return { api, clock, transport, controller }
}

describe('API contract and conservative polling', () => {
  it.each([
    ['latest_reset', 'reset_type', 'banked'], ['latest_reset', 'source', 'observed'],
    ['scheduled_reset', 'reset_type', 'regular'], ['scheduled_reset', 'source', 'x_post'],
    ['active_watch', 'level', 'strong'], ['active_watch', 'source', 'observed'],
  ] as const)('requires string enum values for status %s.%s', (section, field, valid) => {
    const snapshot = status({ latest_reset: reset({ reset_type: 'banked' }), scheduled_reset: scheduled(), active_watch: watch() })
    const record = snapshot.data[section]! as unknown as Record<string, unknown>
    const set = (value: unknown) => { record[field] = field === 'source' ? { type: value } : value }
    set(valid)
    expect(parseStatus(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
    for (const invalid of [[valid], [[valid]], [], {}, true, 1, null, valid.toUpperCase()]) {
      set(invalid)
      expect(() => parseStatus(JSON.parse(JSON.stringify(snapshot)))).toThrow()
    }
  })

  it.each(['reset_type', 'source'] as const)('rejects coerced %s in history records', field => {
    const record = reset({ reset_type: 'banked' }) as unknown as Record<string, unknown>
    const history = { data: [record], pagination: { has_more: false, next_cursor: null } }
    expect(parseHistory(history).data[0]?.reset_type).toBe('banked')
    record[field] = field === 'source' ? { type: ['observed'] } : ['banked']
    expect(() => parseHistory(JSON.parse(JSON.stringify(history)))).toThrow()
  })

  it.each(['status', 'recent', 'history'] as const)('does not cache malformed enum data from %s and recovers after backoff', async endpoint => {
    const { api, clock, transport } = setup()
    const invalid = { ...reset(), reset_type: ['banked'] }
    const body = endpoint === 'status' ? status({ latest_reset: invalid as never })
      : { data: [invalid], pagination: { has_more: false, next_cursor: null } }
    const request = () => endpoint === 'history' ? api.history(new Date(clock.now()).toISOString()) : api[endpoint]()
    transport.mockResolvedValue(response(JSON.stringify(body)))
    await expect(request()).rejects.toThrow()
    expect(api.retryAt).toBe(clock.now() + 300_000)
    await expect(request()).rejects.toBeInstanceOf(ApiError)
    expect(transport).toHaveBeenCalledTimes(1)
    clock.advance(300_000)
    const corrected = endpoint === 'status' ? status({ latest_reset: reset({ reset_type: 'banked' }) })
      : { data: [reset({ reset_type: 'banked' })], pagination: { has_more: false, next_cursor: null } }
    transport.mockResolvedValue(response(corrected))
    await expect(request()).resolves.toEqual(corrected)
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('coalesces and caches latest-three queries while sharing request spacing with status', async () => {
    const { api, clock, transport } = setup()
    const recent = { data: [reset()], pagination: { has_more: false, next_cursor: null } }
    transport.mockImplementation(async url => response(url.includes('/resets?') ? recent : status()))
    await api.status()
    expect(await Promise.all([api.recent(), api.recent(), api.recent()])).toEqual([recent, recent, recent])
    expect(transport).toHaveBeenCalledTimes(2)
    expect(new URL(transport.mock.calls[1]![0]).searchParams.toString()).toBe('limit=3&order=desc')
    expect(clock.delays).toEqual([5000])
    await api.recent()
    expect(transport).toHaveBeenCalledTimes(2)
    clock.advance(60_000)
    await api.recent()
    expect(transport).toHaveBeenCalledTimes(3)
  })

  it('leaves chronological catch-up parameters untouched after an interactive recent query', async () => {
    const { api, transport } = setup()
    transport.mockResolvedValue(response({ data: [], pagination: { has_more: false, next_cursor: null } }))
    await api.recent()
    const from = '2026-10-25T00:00:00Z'
    await api.history(from, 'saved-cursor', 50)
    const params = new URL(transport.mock.calls[1]![0]).searchParams
    expect(Object.fromEntries(params)).toEqual({ from, cursor: 'saved-cursor', limit: '50', order: 'asc' })
  })

  it('refreshes the recent cache when a fresh status reports a different latest reset', async () => {
    const { api, clock, transport } = setup()
    let latest = reset()
    transport.mockImplementation(async url => response(url.includes('/resets?')
      ? { data: [latest], pagination: { has_more: false, next_cursor: null } } : status({ latest_reset: latest })))
    await api.status()
    await api.recent()
    latest = reset({ id: 'new-latest' })
    clock.advance(1)
    await api.status(clock.now())
    expect((await api.recent()).data[0]?.id).toBe('new-latest')
    expect(transport).toHaveBeenCalledTimes(4)
  })

  it('does not let recent-history reads bypass a shared Retry-After deadline', async () => {
    const { api, transport } = setup()
    transport.mockResolvedValue(response({}, 429, { 'retry-after': '3600' }))
    await expect(api.status()).rejects.toBeInstanceOf(ApiError)
    await expect(api.recent()).rejects.toBeInstanceOf(ApiError)
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('does not cache a recent-history response whose durable request-state write failed', async () => {
    const clock = makeClock(), store = new MemoryStore()
    const save = store.saveApiState.bind(store)
    let writes = 0
    vi.spyOn(store, 'saveApiState').mockImplementation(async value => {
      if (++writes === 2) throw new Error('write failed')
      await save(value)
    })
    const transport = vi.fn<Transport>(async () => response({ data: [], pagination: { has_more: false, next_cursor: null } }))
    const api = new CodexApi(transport, { clock, cacheMs: 60_000, signal: new AbortController().signal, stateStore: store })
    await expect(api.recent()).rejects.toThrow('write failed')
    expect(store.requestState?.requestPending).toBe(true)
    await api.recent()
    expect(store.requestState?.requestPending).toBe(false)
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('does not return a cached recent-history response after disposal', async () => {
    const { api, transport, controller } = setup()
    transport.mockResolvedValue(response({ data: [], pagination: { has_more: false, next_cursor: null } }))
    await api.recent()
    controller.abort()
    await expect(api.recent()).rejects.toThrow()
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it.each(['3600', '172800', new Date(Date.parse('2026-10-25T04:00:00Z') + 7200_000).toUTCString()])(
    'does not guess a retry deadline after losing the response state for Retry-After %s', async retryAfter => {
      const clock = makeClock(), store = new MemoryStore()
      const save = store.saveApiState.bind(store)
      let writes = 0
      vi.spyOn(store, 'saveApiState').mockImplementation(async value => {
        if (++writes > 1) throw new Error('response write failed')
        await save(value)
      })
      const transport = vi.fn<Transport>(async () => response({}, 429, { 'retry-after': retryAfter }))
      const options = { clock, cacheMs: 60_000, signal: new AbortController().signal, stateStore: store }
      await expect(new CodexApi(transport, options).status()).rejects.toThrow('response write failed')
      const restored = new CodexApi(transport, options)
      await expect(restored.status()).rejects.toThrow('未完成')
      clock.advance(3600_000)
      await expect(restored.history(new Date(clock.now()).toISOString())).rejects.toThrow('未完成')
      expect(transport).toHaveBeenCalledTimes(1)
    },
  )

  it('flushes a known response deadline without contacting upstream when persistence recovers', async () => {
    const clock = makeClock(), store = new MemoryStore()
    const save = store.saveApiState.bind(store)
    let writes = 0, broken = true
    vi.spyOn(store, 'saveApiState').mockImplementation(async value => {
      if (++writes > 1 && broken) throw new Error('database unavailable')
      await save(value)
    })
    const transport = vi.fn<Transport>(async () => response({}, 429, { 'retry-after': '172800' }))
    const options = { clock, cacheMs: 60_000, signal: new AbortController().signal, stateStore: store }
    const api = new CodexApi(transport, options)
    const deadline = clock.now() + 172800_000
    await expect(api.status()).rejects.toThrow(String(deadline))
    await expect(api.flushState()).rejects.toThrow('database unavailable')
    expect(store.requestState?.requestPending).toBe(true)
    broken = false
    await api.flushState()
    expect(store.requestState).toMatchObject({ blockedUntil: deadline, requestPending: false, failures: 1 })
    const restored = new CodexApi(transport, options)
    await expect(restored.status()).rejects.toBeInstanceOf(ApiError)
    expect(restored.retryAt).toBe(deadline)
    expect(transport).toHaveBeenCalledTimes(1)
    clock.advance(172800_000)
    transport.mockResolvedValue(response())
    await expect(restored.status()).resolves.toEqual(status())
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('retries a failed successful-response write before using its cached snapshot', async () => {
    const clock = makeClock(), store = new MemoryStore()
    const save = store.saveApiState.bind(store)
    vi.spyOn(store, 'saveApiState').mockImplementationOnce(save).mockRejectedValueOnce(new Error('response write failed'))
    const transport = vi.fn<Transport>(async () => response())
    const api = new CodexApi(transport, { clock, cacheMs: 60_000, signal: new AbortController().signal, stateStore: store })
    await expect(api.status()).rejects.toThrow('response write failed')
    expect(store.requestState?.requestPending).toBe(true)
    await expect(api.status()).resolves.toEqual(status())
    expect(store.requestState?.requestPending).toBe(false)
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('rechecks a recovery hold after an operator restores a confirmed retry deadline', async () => {
    const clock = makeClock(), store = new MemoryStore()
    store.requestState = { lastRequestAt: clock.now(), blockedUntil: 0, failures: 0, requestPending: true }
    const transport = vi.fn<Transport>(async () => response())
    const api = new CodexApi(transport, { clock, cacheMs: 60_000, signal: new AbortController().signal, stateStore: store })
    await expect(api.status()).rejects.toThrow('未完成')
    await api.flushState()
    expect(store.requestState.requestPending).toBe(true)
    const deadline = clock.now() + 7200_000
    await store.saveApiState({ ...store.requestState, blockedUntil: deadline, requestPending: false, failures: 1 })
    await expect(api.status()).rejects.toBeInstanceOf(ApiError)
    expect(transport).not.toHaveBeenCalled()
    clock.advance(7200_000)
    await expect(api.status()).resolves.toEqual(status())
  })

  it('accepts legacy request state without an unfinished-request field', async () => {
    const clock = makeClock(), store = new MemoryStore()
    store.requestState = { lastRequestAt: clock.now(), blockedUntil: 0, failures: 0 }
    const transport = vi.fn<Transport>(async () => response())
    await new CodexApi(transport, { clock, cacheMs: 60_000, signal: new AbortController().signal, stateStore: store }).status()
    expect(transport).toHaveBeenCalledTimes(1)
    expect(clock.delays).toEqual([5000])
    expect(store.requestState.requestPending).toBe(false)
  })

  it('uses the actual dispatch time to validate a cache after a slow preflight write', async () => {
    const clock = makeClock(), store = new MemoryStore()
    const registeredAt = clock.now() + 1000
    const save = store.saveApiState.bind(store)
    vi.spyOn(store, 'saveApiState').mockImplementationOnce(async state => {
      await save(state)
      clock.advance(6000)
    })
    const transport = vi.fn<Transport>(async () => response())
    const api = new CodexApi(transport, { clock, cacheMs: 60_000, signal: new AbortController().signal, stateStore: store })
    await api.status()
    await api.status(registeredAt)
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it.each([1, 6000, 20_000])('keeps actual HTTP starts five seconds apart after a %i ms state write', async latency => {
    const clock = makeClock(), store = new MemoryStore()
    const save = store.saveApiState.bind(store)
    vi.spyOn(store, 'saveApiState').mockImplementationOnce(async state => {
      await save(state)
      clock.advance(latency)
    })
    const times: number[] = []
    const transport = vi.fn<Transport>(async url => {
      times.push(clock.now())
      return url.includes('/resets?') ? response({ data: [], pagination: { has_more: false, next_cursor: null } }) : response()
    })
    const api = new CodexApi(transport, { clock, cacheMs: 60_000, signal: new AbortController().signal, stateStore: store })
    await api.status()
    await api.history(new Date(clock.now()).toISOString())
    expect(times).toHaveLength(2)
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(5000)
    expect(store.requestState?.lastRequestAt).toBe(times[1])
  })

  it('holds requests after reload when an in-flight dispatch had no durable outcome', async () => {
    const clock = makeClock(), store = new MemoryStore(), controller = new AbortController()
    const save = store.saveApiState.bind(store)
    vi.spyOn(store, 'saveApiState').mockImplementationOnce(async state => {
      await save(state)
      clock.advance(6000)
    })
    let started!: () => void, rejectRequest!: (error: Error) => void
    const dispatched = new Promise<void>(resolve => { started = resolve })
    let dispatchedAt = 0
    const first = new CodexApi(async () => {
      dispatchedAt = clock.now()
      started()
      return new Promise((_resolve, reject) => { rejectRequest = reject })
    }, { clock, cacheMs: 60_000, signal: controller.signal, stateStore: store })
    const pending = first.status()
    const rejected = expect(pending).rejects.toThrow('disposed')
    await dispatched
    controller.abort()
    rejectRequest(new Error('disposed'))
    await rejected
    expect(store.requestState?.lastRequestAt).toBeLessThan(dispatchedAt)
    const transport = vi.fn<Transport>(async () => response())
    const second = new CodexApi(transport, { clock, cacheMs: 60_000, signal: new AbortController().signal, stateStore: store })
    await expect(second.status()).rejects.toThrow('未完成')
    expect(transport).not.toHaveBeenCalled()
  })

  it('does not treat a slow pre-registration response as a post-registration snapshot', async () => {
    const { api, transport, clock } = setup()
    let release!: () => void
    let started!: () => void
    const inFlight = new Promise<void>(resolve => { started = resolve })
    transport.mockImplementationOnce(async () => {
      started()
      await new Promise<void>(resolve => { release = resolve })
      return response(status())
    })
    const before = api.status()
    await inFlight
    clock.advance(1000)
    const after = api.status(clock.now())
    release()
    await Promise.all([before, after])
    expect(transport).toHaveBeenCalledTimes(2)
    expect(clock.delays).toEqual([4000])
  })

  it('revalidates a cache predating registration, keeping spacing and coalescing callers', async () => {
    const { api, transport, clock } = setup()
    transport.mockResolvedValueOnce(response(status(), 200, { etag: 'W/"baseline"' }))
      .mockResolvedValueOnce(response(undefined, 304))
    await api.status()
    clock.advance(1000)
    const registeredAt = clock.now()
    await Promise.all([api.status(registeredAt), api.status(registeredAt)])
    expect(transport).toHaveBeenCalledTimes(2)
    expect(transport.mock.calls[1]?.[1]['If-None-Match']).toBe('W/"baseline"')
    expect(clock.delays).toEqual([4000])
    await api.status(registeredAt)
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('does not use a pre-registration cache to bypass an active cooldown', async () => {
    const { api, transport, clock } = setup()
    await api.status()
    clock.advance(1000)
    const registeredAt = clock.now()
    transport.mockResolvedValueOnce(response({ detail: 'Slow down' }, 429, { 'retry-after': '300' }))
    await expect(api.history(new Date(registeredAt).toISOString())).rejects.toBeInstanceOf(ApiError)
    await expect(api.status(registeredAt)).rejects.toBeInstanceOf(ApiError)
    expect(transport).toHaveBeenCalledTimes(2)
    await expect(api.status()).resolves.toEqual(status())
  })

  it('preserves Retry-After across client recreation and both endpoints', async () => {
    const clock = makeClock()
    const store = new MemoryStore()
    const transport = vi.fn<Transport>(async () => response())
    const options = { cacheMs: 60_000, clock, signal: new AbortController().signal, stateStore: store }
    transport.mockResolvedValueOnce(response({ detail: 'Slow down' }, 429, { 'retry-after': '3600' }))
    const first = new CodexApi(transport, options)
    await expect(first.status()).rejects.toBeInstanceOf(ApiError)
    const deadline = clock.now() + 3600_000
    const reloaded = new CodexApi(transport, options)
    await expect(reloaded.status()).rejects.toBeInstanceOf(ApiError)
    await expect(reloaded.history(new Date(clock.now()).toISOString())).rejects.toBeInstanceOf(ApiError)
    expect(reloaded.retryAt).toBe(deadline)
    expect(transport).toHaveBeenCalledTimes(1)
    clock.advance(3600_000)
    await expect(reloaded.status()).resolves.toEqual(status())
    expect(store.requestState?.blockedUntil).toBe(0)
  })

  it('keeps fixed network backoff and request spacing after reload', async () => {
    const clock = makeClock(), store = new MemoryStore()
    const transport = vi.fn<Transport>(async () => { throw new Error('offline') })
    const options = { cacheMs: 60_000, clock, signal: new AbortController().signal, stateStore: store }
    await expect(new CodexApi(transport, options).status()).rejects.toThrow('offline')
    clock.advance(300_000)
    await expect(new CodexApi(transport, options).status()).rejects.toThrow('offline')
    expect(store.requestState?.blockedUntil! - clock.now()).toBe(300_000)
    clock.advance(300_000)
    transport.mockResolvedValue(response())
    await new CodexApi(transport, options).status()
    const previousRequestTime = clock.now()
    await new CodexApi(transport, options).status()
    expect(clock.now() - previousRequestTime).toBeGreaterThanOrEqual(5000)
  })

  it('does not request the upstream if durable request state cannot be saved', async () => {
    const clock = makeClock(), store = new MemoryStore()
    vi.spyOn(store, 'saveApiState').mockRejectedValue(new Error('database unavailable'))
    const transport = vi.fn<Transport>(async () => response())
    const api = new CodexApi(transport, { cacheMs: 60_000, clock, signal: new AbortController().signal, stateStore: store })
    await expect(api.status()).rejects.toThrow('database unavailable')
    expect(transport).not.toHaveBeenCalled()
  })

  it('preserves an HTTP-date Retry-After deadline after reload', async () => {
    const clock = makeClock(), store = new MemoryStore()
    const deadline = clock.now() + 7200_000
    const transport = vi.fn<Transport>(async () => response({ detail: 'Unavailable' }, 503, {
      'retry-after': new Date(deadline).toUTCString(),
    }))
    const options = { cacheMs: 60_000, clock, signal: new AbortController().signal, stateStore: store }
    await expect(new CodexApi(transport, options).status()).rejects.toBeInstanceOf(ApiError)
    clock.advance(60_000)
    const reloaded = new CodexApi(transport, options)
    await expect(reloaded.status()).rejects.toBeInstanceOf(ApiError)
    expect(reloaded.retryAt).toBe(deadline)
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('does not contact upstream if durable request state cannot be restored', async () => {
    const store = new MemoryStore()
    vi.spyOn(store, 'apiState').mockRejectedValue(new Error('database unavailable'))
    const transport = vi.fn<Transport>(async () => response())
    const api = new CodexApi(transport, { cacheMs: 60_000, clock: makeClock(), signal: new AbortController().signal, stateStore: store })
    await expect(api.status()).rejects.toThrow('database unavailable')
    expect(transport).not.toHaveBeenCalled()
  })

  it('does not start a request if disposed while durable state was being saved', async () => {
    const store = new MemoryStore(), controller = new AbortController()
    const originalSave = store.saveApiState.bind(store)
    vi.spyOn(store, 'saveApiState').mockImplementation(async value => {
      await originalSave(value)
      controller.abort()
    })
    const transport = vi.fn<Transport>(async () => response())
    const api = new CodexApi(transport, { cacheMs: 60_000, clock: makeClock(), signal: controller.signal, stateStore: store })
    await expect(api.status()).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
    expect(store.requestState?.requestPending).toBe(false)
    await new CodexApi(transport, { cacheMs: 60_000, clock: makeClock(), signal: new AbortController().signal, stateStore: store }).status()
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('accepts nullable forecasts, nullable scheduled time, and observed sources without URL/author', () => {
    const value = status({ active_watch: watch({ reset_chance_percent: null }), scheduled_reset: {
      ...reset(), status: 'scheduled', scheduled_for: null,
    } })
    expect(parseStatus(value)).toEqual(value)
    expect(typeof parseStatus(value).data.latest_reset?.id).toBe('string')
  })

  it('rejects missing or malformed status fields instead of sending a false notification', () => {
    expect(() => parseStatus({ data: {}, meta: {} })).toThrow()
    expect(() => parseStatus(status({ active_watch: watch({ reset_chance_percent: 110 }) }))).toThrow()
  })

  it('coalesces status cache reads even when callers arrive together', async () => {
    const { api, transport } = setup()
    await Promise.all([api.status(), api.status(), api.status()])
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('reuses cached data for a 304 and sends the saved ETag', async () => {
    const { api, transport, clock } = setup()
    transport.mockResolvedValueOnce(response(status(), 200, { etag: 'W/"first"' }))
      .mockResolvedValueOnce(response(undefined, 304))
    const initial = await api.status()
    clock.advance(60_001)
    expect(await api.status()).toEqual(initial)
    expect(transport.mock.calls[1]?.[1]['If-None-Match']).toBe('W/"first"')
  })

  it('serializes different endpoints with at least five seconds between requests', async () => {
    const { api, transport, clock } = setup()
    const times: number[] = []
    transport.mockImplementation(async url => {
      times.push(clock.now())
      return url.includes('/resets?') ? response({ data: [], pagination: { has_more: false, next_cursor: null } }) : response()
    })
    await Promise.all([api.status(), api.history(new Date(clock.now()).toISOString())])
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(5000)
    expect(clock.delays).toEqual([5000])
  })

  it('honors Retry-After across endpoints without making additional requests', async () => {
    const { api, transport, clock } = setup()
    transport.mockResolvedValueOnce(response({ detail: 'Slow down' }, 429, { 'retry-after': '300' }))
    await expect(api.status()).rejects.toBeInstanceOf(ApiError)
    expect(api.retryAt - clock.now()).toBe(300_000)
    await expect(api.history(new Date(clock.now()).toISOString())).rejects.toBeInstanceOf(ApiError)
    expect(transport).toHaveBeenCalledTimes(1)
    clock.advance(300_000)
    await expect(api.status()).resolves.toEqual(status())
  })

  it('backs off on service failures and malformed JSON, preserving the old status cache', async () => {
    const { api, transport, clock } = setup()
    await api.status()
    clock.advance(60_001)
    transport.mockResolvedValueOnce(response({ detail: 'Unavailable' }, 503))
    await expect(api.status()).rejects.toThrow('Unavailable')
    expect(api.retryAt).toBeGreaterThan(clock.now())
    clock.advance(300_000)
    transport.mockResolvedValueOnce(response('broken json'))
    await expect(api.status()).rejects.toThrow()
    expect(api.retryAt).toBeGreaterThan(clock.now())
  })

  it('validates pagination and keeps very large X IDs as strings', () => {
    const value = { data: [reset({ id: '99999999999999999999' })], pagination: { has_more: false, next_cursor: null } }
    expect(parseHistory(value).data[0]?.id).toBe('99999999999999999999')
    expect(() => parseHistory({ ...value, pagination: { has_more: true, next_cursor: null } })).toThrow()
  })

  it('does not make a request after disposal', async () => {
    const { api, controller, transport } = setup()
    controller.abort()
    await expect(api.status()).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })
})
