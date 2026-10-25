import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { formatNotification, formatOverview, formatTime } from '../src/format'
import type { Locale } from '../src/locales'
import { Monitor } from '../src/monitor'
import { makeApi, makeClock, MemoryStore, NOW, reset, status, target, watch, scheduled } from './helpers'

const examples: { locale: Locale; label: string; parts: number[]; hour: number; stamp: string }[] = [
  { locale: 'en-US', label: '(UTC)', parts: [12, 31, 2026, 16, 30], hour: 16, stamp: '12/31/2026, 16:30 (UTC)' },
  { locale: 'zh-CN', label: '(UTC+08:00)', parts: [2027, 1, 1, 0, 30], hour: 0, stamp: '2027/01/01 00:30 (UTC+08:00)' },
  { locale: 'zh-TW', label: '(UTC+08:00)', parts: [2027, 1, 1, 0, 30], hour: 0, stamp: '2027/01/01 00:30 (UTC+08:00)' },
  { locale: 'ja-JP', label: '(UTC+09:00)', parts: [2027, 1, 1, 1, 30], hour: 1, stamp: '2027/01/01 01:30 (UTC+09:00)' },
  { locale: 'ko-KR', label: '(UTC+09:00)', parts: [2027, 1, 1, 1, 30], hour: 1, stamp: '2027. 01. 01. 01:30 (UTC+09:00)' },
]
const instant = '2026-12-31T16:30:00Z'
const numericParts = (formatted: string) => formatted.split(' (')[0]!.match(/\d+/g)!.map(Number)
// ICU versions may use a thin or non-breaking space between localized date/time fields.
const normalizeSpacing = (formatted: string) => formatted.replace(/[\u00a0\u2009\u202f]/g, ' ')

describe('language-based fixed time zones', () => {
  it.each(examples)('converts equivalent timestamps and year rollover correctly in $locale', ({ locale, parts, stamp }) => {
    for (const value of [instant, '2026-12-31T08:30:00-08:00', '2027-01-01T00:30:00+08:00']) {
      const formatted = formatTime(value, locale)
      expect(numericParts(formatted)).toEqual(parts)
      expect(normalizeSpacing(formatted)).toBe(stamp)
    }
  })

  it.each(examples.flatMap(example => [1, 7].map(month => ({ ...example, month }))))(
    'keeps the fixed offset in $locale during month $month', ({ locale, label, hour, month }) => {
      const formatted = formatTime('2026-' + String(month).padStart(2, '0') + '-15T16:30:00Z', locale)
      expect(numericParts(formatted)).toEqual(locale === 'en-US' ? [month, 15, 2026, hour, 30] : [2026, month, 16, hour, 30])
      expect(formatted.endsWith(label)).toBe(true)
    },
  )

  it.each(examples)('uses $locale consistently for status, scheduled time, history, reset and forecast expiry', ({ locale, stamp, label }) => {
    const record = reset({ announced_at: instant, text: 'Original announcement at 8:30 PT' })
    const snapshot = status({
      latest_reset: record,
      scheduled_reset: { ...record, status: 'scheduled', scheduled_for: instant },
    })
    snapshot.meta.generated_at = instant
    const history = [record, { ...record, id: 'second' }, { ...record, id: 'third' }]
    const prediction = watch({ expires_at: instant, forecast_window: 'today, 10:00 PT', text: 'Original forecast text' })
    const before = structuredClone({ snapshot, history, prediction })
    const overview = normalizeSpacing(formatOverview(snapshot, history, locale, Date.parse(instant), locale))
    expect(overview.split(stamp.split(' (')[0]!)).toHaveLength(5) // scheduled + three history entries
    expect(overview.split(label.slice(1, -1))).toHaveLength(2) // one shared time zone
    for (const reset_type of ['regular', 'banked'] as const) {
      const message = formatNotification({ type: 'reset', reset: { ...record, reset_type } }, locale)
      expect(normalizeSpacing(message)).toContain(stamp)
      expect(message).not.toContain(record.text)
    }
    const message = formatNotification({ type: 'scheduled', scheduled: scheduled({ announced_at: instant, scheduled_for: instant, text: 'Original announcement' }) }, locale)
    expect(normalizeSpacing(message)).toContain(stamp)
    expect(message).not.toContain('Original announcement')
    expect({ snapshot, history, prediction }).toEqual(before)
  })

  it('does not inherit the server or Docker time zone', () => {
    const script = "const { formatTime } = require('./lib/format'); console.log(JSON.stringify(['en-US','zh-CN','zh-TW','ja-JP','ko-KR'].map(locale => formatTime('2026-12-31T16:30:00Z', locale))))"
    for (const TZ of ['America/Los_Angeles', 'Pacific/Auckland']) {
      const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, TZ } })
      expect(JSON.parse(output).map(normalizeSpacing)).toEqual(examples.map(example => example.stamp))
    }
  })

  it.each(examples)('reformats queued reset and announcement retries in $locale after restart without replaying delivered events', async ({ locale, label }) => {
    const store = new MemoryStore(), clock = makeClock(), destination = target()
    const { api, state } = makeApi(status())
    const send = vi.fn(async (_target: unknown, _message: string) => {})
    const options = { clock, sendDelayMs: 1000, signal: new AbortController().signal, report: vi.fn() }
    const monitor = new Monitor(store, api, send, options)
    await monitor.subscribe(destination, 'zh-CN')
    await monitor.poll()
    const original = await store.subscription(destination.id)
    clock.advance(1000)
    state.current = status({ latest_reset: reset({ id: 'new', announced_at: new Date(clock.now()).toISOString() }), scheduled_reset: scheduled() })
    send.mockRejectedValue(new Error('offline'))
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.every(([, message]) => message.includes('(UTC+08:00)'))).toBe(true)
    const queued = [...store.deliveries.values()].map(({ id, retryAt, attempts }) => ({ id, retryAt, attempts }))
    await monitor.subscribe(destination, locale)
    expect(await store.subscription(destination.id)).toMatchObject({ generation: original!.generation, subscribedAt: original!.subscribedAt, locale })
    expect([...store.deliveries.values()].map(({ id, retryAt, attempts }) => ({ id, retryAt, attempts }))).toEqual(queued)
    clock.advance(60_000)
    send.mockReset().mockResolvedValue(undefined)
    const restarted = new Monitor(store, api, send, options)
    await restarted.poll()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.every(([, message]) => message.includes(label))).toBe(true)
    expect([...store.deliveries.values()].every(delivery => delivery.sentAt > 0)).toBe(true)
    await monitor.subscribe(destination, 'en-US')
    await restarted.poll()
    expect(send).toHaveBeenCalledTimes(2)
    expect(clock.now()).toBeGreaterThan(NOW)
  })
})
