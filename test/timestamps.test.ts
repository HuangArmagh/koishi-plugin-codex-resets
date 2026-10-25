import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, CodexApi, parseHistory, parseStatus } from '../src/api'
import type { Transport } from '../src/api'
import { Monitor } from '../src/monitor'
import type { StatusResponse } from '../src/types'
import { makeClock, MemoryStore, NOW, reset, status, target, watch } from './helpers'

const qualified = '2026-10-25T06:06:16.123Z'
const unqualified = '2026-10-25T06:06:16'
const snapshot = () => status({
  active_watch: watch(),
  scheduled_reset: { ...reset(), status: 'scheduled', scheduled_for: qualified },
})
const history = (announced_at = qualified) => ({
  data: [reset({ announced_at })], pagination: { has_more: false, next_cursor: null },
})
const fields: { name: string; set: (value: StatusResponse, timestamp: string) => void }[] = [
  { name: 'latest_reset.announced_at', set: (value, timestamp) => { value.data.latest_reset!.announced_at = timestamp } },
  { name: 'scheduled_reset.announced_at', set: (value, timestamp) => { value.data.scheduled_reset!.announced_at = timestamp } },
  { name: 'scheduled_reset.scheduled_for', set: (value, timestamp) => { value.data.scheduled_reset!.scheduled_for = timestamp } },
  { name: 'active_watch.observed_at', set: (value, timestamp) => { value.data.active_watch!.observed_at = timestamp } },
  { name: 'active_watch.expires_at', set: (value, timestamp) => { value.data.active_watch!.expires_at = timestamp } },
  { name: 'stats.last_reset_at', set: (value, timestamp) => { value.data.stats.last_reset_at = timestamp } },
  { name: 'meta.generated_at', set: (value, timestamp) => { value.meta.generated_at = timestamp } },
]

describe('unambiguous API timestamps', () => {
  it.each(fields)('rejects a missing timezone in $name', ({ set }) => {
    const value = snapshot()
    set(value, unqualified)
    expect(() => parseStatus(value)).toThrow('API 状态字段')
  })

  it.each([
    '2026-10-25T06:06:16Z',
    '2026-10-25t06:06:16z',
    '2026-10-25T06:06:16.1Z',
    qualified,
    '2026-10-25T06:06:16.123456789Z',
    '2026-10-25T14:06:16.123+08:00',
    '2026-10-24T23:06:16.123-07:00',
    '2026-10-25T11:36:16.123+05:30',
    '2026-10-25T18:51:16.123+12:45',
    '2026-10-25T06:06:16+00:00',
    '2026-10-25T06:06:16-00:00',
    '2024-02-29T23:59:59.999Z',
    '2000-02-29T00:00:00Z',
    '0000-02-29T00:00:00Z',
    '0096-02-29T00:00:00Z',
    '9999-12-31T23:59:59Z',
  ])('accepts explicit offsets, fractions and valid calendar boundaries: %s', timestamp => {
    const value = snapshot()
    for (const { set } of fields) set(value, timestamp)
    const before = structuredClone(value)
    expect(parseStatus(value)).toEqual(before)
    expect(parseHistory(history(timestamp)).data[0]!.announced_at).toBe(timestamp)
    expect(value).toEqual(before)
  })

  it.each([
    unqualified, '2026-10-25', '1', '',
    '2026-10-25 06:06:16Z', '2026-10-25T06:06Z',
    '2026-10-25T06:06:16+0800', '2026-10-25T06:06:16+08',
    '2026-10-25T06:06:16+24:00', '2026-10-25T06:06:16-24:00',
    '2026-10-25T06:06:16+08:60', '2026-10-25T06:06:16 PST',
    '2026-02-29T00:00:00Z', '1900-02-29T00:00:00Z', '2100-02-29T00:00:00Z',
    '2024-02-30T00:00:00Z', '2026-04-31T00:00:00+08:00',
    '2026-00-25T00:00:00Z', '2026-13-25T00:00:00Z',
    '2026-10-00T00:00:00Z', '2026-10-32T00:00:00Z',
    '2026-10-25T24:00:00Z', '2026-10-25T06:60:00Z', '2026-10-25T06:06:61Z',
    '2026-10-25T06:06:16.Z', '2026-10-25T06:06:16,123Z',
    '+010000-01-01T00:00:00Z',
    '2026-10-25T06:06:16Z\n', ' 2026-10-25T06:06:16Z', '2026-10-25T06:06:16Z ',
    '2016-12-31T23:59:60Z', // JavaScript Date cannot represent leap seconds.
  ])('rejects incomplete, ambiguous or unrepresentable timestamps: %j', timestamp => {
    expect(() => parseStatus(status({ latest_reset: reset({ announced_at: timestamp }) }))).toThrow()
    expect(() => parseHistory(history(timestamp))).toThrow()
  })

  it('retains nullable scheduled and statistics times without accepting null for required timestamps', () => {
    const value = snapshot()
    value.data.scheduled_reset!.scheduled_for = null
    value.data.stats.last_reset_at = null
    expect(parseStatus(value)).toEqual(value)
    for (const { name, set } of fields.filter(field => !['scheduled_reset.scheduled_for', 'stats.last_reset_at'].includes(field.name))) {
      for (const timestamp of [null, undefined, 1792908376000]) {
        const invalid = snapshot()
        set(invalid, timestamp as never)
        expect(() => parseStatus(invalid), name).toThrow()
      }
    }
  })

  it.each(['UTC', 'America/Los_Angeles', 'Asia/Shanghai'])('validates and renders consistently on a server using %s', TZ => {
    const script = [
      "const { parseStatus, parseHistory } = require('./lib/api')",
      "const { formatReset, formatOverview } = require('./lib/format')",
      'const input = ' + JSON.stringify(snapshot()),
      'const page = ' + JSON.stringify(history(unqualified)),
      'input.data.latest_reset.announced_at = ' + JSON.stringify(unqualified),
      'let rejectedStatus = false, rejectedHistory = false',
      'try { parseStatus(input) } catch { rejectedStatus = true }',
      'try { parseHistory(page) } catch { rejectedHistory = true }',
      'input.data.latest_reset.announced_at = ' + JSON.stringify(qualified),
      'input.data.active_watch.expires_at = ' + JSON.stringify(qualified),
      'const valid = parseStatus(input)',
      "const now = Date.parse('2026-10-25T08:00:00Z')",
      "const announcement = formatOverview(valid, [], undefined, now, 'zh-CN')",
      "const noAnnouncement = formatOverview({ ...valid, data: { ...valid.data, scheduled_reset: null } }, [], undefined, now, 'zh-CN')",
      "console.log(JSON.stringify({ rejectedStatus, rejectedHistory, time: formatReset(valid.data.latest_reset, 'zh-CN').split('\\n').find(line => line.startsWith('重置记录时间：')), prioritizesScheduled: announcement.includes('待执行公告：2026/10/25 14:06') && !announcement.includes('当前无有效重置预测'), expired: noAnnouncement.includes('当前无有效重置预测') }))",
    ].join('\n')
    const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, TZ } })
    expect(JSON.parse(output)).toEqual({
      rejectedStatus: true, rejectedHistory: true, prioritizesScheduled: true, expired: true,
      time: '重置记录时间：2026/10/25 14:06 (UTC+08:00)',
    })
  })

  it.each(['status', 'recent', 'history'] as const)('rejects bad %s timestamps without caching them and persists the shared backoff', async endpoint => {
    const clock = makeClock(), store = new MemoryStore()
    const invalid = status({ latest_reset: reset({ announced_at: unqualified }) })
    let body: unknown = endpoint === 'status' ? invalid : history(unqualified)
    const transport = vi.fn<Transport>(async () => ({ status: 200, headers: new Headers(), body }))
    const api = new CodexApi(transport, { clock, stateStore: store, cacheMs: 300_000, signal: new AbortController().signal })
    const read = () => endpoint === 'history' ? api.history(new Date(NOW).toISOString()) : api[endpoint]()
    await expect(read()).rejects.toThrow('API')
    expect(store.requestState).toMatchObject({ requestPending: false, failures: 1, blockedUntil: NOW + 60_000 })
    await expect(read()).rejects.toBeInstanceOf(ApiError)
    await expect(api.history(new Date(NOW).toISOString())).rejects.toBeInstanceOf(ApiError)
    expect(transport).toHaveBeenCalledTimes(1)
    clock.advance(60_000)
    body = endpoint === 'status' ? status() : history()
    await expect(read()).resolves.toEqual(body)
    expect(transport).toHaveBeenCalledTimes(2)
    expect(store.requestState).toMatchObject({ failures: 0, blockedUntil: 0, requestPending: false })
  })

  it('does not advance a subscription baseline or use a status snapshot with an ambiguous forecast expiry', async () => {
    const clock = makeClock(), store = new MemoryStore(), send = vi.fn(async () => {})
    let body = status({ active_watch: watch({ expires_at: unqualified }) })
    const api = new CodexApi(async () => ({ status: 200, headers: new Headers(), body }), {
      clock, stateStore: store, cacheMs: 60_000, signal: new AbortController().signal,
    })
    const monitor = new Monitor(store, api, send, { clock, sendDelayMs: 1000, signal: new AbortController().signal, report: vi.fn() })
    await monitor.subscribe(target())
    await expect(monitor.poll()).rejects.toThrow('API 状态字段')
    expect(store.state).toBeNull()
    expect((await store.subscription(target().id))?.baselined).toBe(false)
    expect(store.deliveries.size).toBe(0)
    expect(send).not.toHaveBeenCalled()
    clock.advance(60_000)
    body = status({ active_watch: watch() })
    await monitor.poll()
    expect((await store.subscription(target().id))?.baselined).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })
})
