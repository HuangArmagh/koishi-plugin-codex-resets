import { describe, expect, it, vi } from 'vitest'
import { formatNotification, formatOverview, formatReset, formatScheduled } from '../src/format'
import { locales, text } from '../src/locales'
import { Monitor } from '../src/monitor'
import { makeApi, makeClock, MemoryStore, NOW, reset, scheduled, status, target, watch } from './helpers'

function setup() {
  const store = new MemoryStore(), clock = makeClock(), { api, state } = makeApi()
  const send = vi.fn(async (_destination: unknown, _message: string) => {})
  const options = { clock, sendDelayMs: 1000, signal: new AbortController().signal, report: vi.fn() }
  const monitor = new Monitor(store, api, send, options)
  return { store, clock, api, state, send, monitor, options }
}

// User-supplied public API output, fixed here rather than fetching the live site during tests.
const actualReset = reset({ id: '2114237083652882932', announced_at: '2026-10-25T06:06:16.000Z',
  text: 'It is all propagated. Enjoy some mad codexing tomorrow. Fun week ahead too. https://t.co/qOrzwSeIZZ https://t.co/xKaK95EAly',
  source: { type: 'x_post', author: 'thsottiaux', url: 'https://x.com/thsottiaux/status/2114237083652882932' },
})
const schemaExample = scheduled({ id: 'string', announced_at: '2026-10-25T10:41:23.321Z',
  scheduled_for: '2026-10-25T10:41:23.321Z', text: 'string',
  source: { type: 'x_post', author: 'thsottiaux', url: 'https://example.com/' },
})

describe('announcements and executions are the only proactive events', () => {
  it.each([
    ['en-US', 'Banked Reset', '[Codex banked reset credit issued]'],
    ['zh-CN', '储备重置', '【Codex 储备重置已发放】'],
    ['zh-TW', '儲備重置', '【Codex 儲備重置已發放】'],
    ['ja-JP', 'ストック型リセット', '【Codex ストック型リセットを付与】'],
    ['ko-KR', '저장형 리셋', '【Codex 저장형 리셋 지급】'],
  ] as const)('uses the agreed banked reset name in all message contexts for %s', (locale, name, title) => {
    const banked = reset({ reset_type: 'banked' })
    expect(formatReset(banked, locale).split('\n')[0]).toBe(title)
    expect(formatScheduled(scheduled({ reset_type: 'banked' }), locale)).toContain(name)
    expect(formatOverview(status(), [banked], undefined, NOW, locale)).toContain(name)
    expect(formatOverview(status({ latest_reset: banked }), null, undefined, NOW, locale)).toContain(name)
  })

  it('renders the supplied schema example separately from the real executed reset', () => {
    expect(formatScheduled(schemaExample)).toBe([
      '【Codex 重置预告】', '已发布明确的重置预告，尚未确认执行。',
      '类型：常规重置\n预定时间：2026/10/25 18:41 (UTC+08:00)',
      '数据来源：https://codex-resets.com',
    ].join('\n\n'))
    expect(formatReset(actualReset)).toBe([
      '【Codex 已执行重置】', '网站记录了重置事件，请检查你的实际额度。',
      '重置记录时间：2026/10/25 14:06 (UTC+08:00)', '数据来源：https://codex-resets.com',
    ].join('\n\n'))
  })

  it.each(locales)('omits upstream copy and evidence while preserving four separated blocks in %s', locale => {
    for (const reset_type of ['regular', 'banked'] as const) {
      for (const source of [{ type: 'observed' as const }, { type: 'x_post' as const, url: 'https://example.com/announcement', author: 'source-author' }]) {
        const details = { reset_type, source, text: 'UPSTREAM_BODY_MUST_NOT_APPEAR' }
        for (const platform of ['', 'discord', 'telegram']) {
          const execution = formatReset(reset(details), locale, platform)
          const announcement = formatScheduled(scheduled({ ...details, scheduled_for: null }), locale, platform)
          for (const message of [execution, announcement]) {
            expect(message.split('\n\n')).toHaveLength(4)
            expect(message.split('\n\n')[3]).toBe(text(locale, 'attribution'))
            expect(message).not.toMatch(/UPSTREAM_BODY|example\.com|source-author|Evidence:|依据：|依據：|根拠：|근거:|Original source:|原始来源：|原始來源：|元の情報源：|원문 출처:/)
            expect(message).not.toMatch(/\n{3}|^\n|\n$|undefined|\{\w+\}/)
          }
          expect(execution.split('\n\n')[0]).toBe(text(locale, reset_type === 'banked' ? 'bankedTitle' : 'resetTitle'))
          expect(execution.split('\n\n')[2]?.split('\n')).toHaveLength(1)
          expect(announcement.split('\n\n')[2]?.split('\n')).toHaveLength(2)
          expect(announcement).toContain(text(locale, 'noSchedule'))
          expect(announcement).toContain(text(locale, 'resetType', { value: text(locale, reset_type === 'banked' ? 'banked' : 'regular') }))
        }
      }
    }
  })

  it('baselines the supplied existing reset without fabricating a scheduled notification', async () => {
    const { monitor, state, clock, send } = setup()
    clock.advance(8 * 3600_000)
    state.current = status({ latest_reset: actualReset, scheduled_reset: null, active_watch: null })
    await monitor.subscribe(target())
    await monitor.poll()
    expect(send).not.toHaveBeenCalled()
    expect(formatOverview(state.current, [actualReset], 'zh-CN', clock.now(), 'zh-CN')).toContain('2026/10/25 14:06 — 常规重置')
  })

  it('sends a pending announcement and later its execution once each with the same upstream id', async () => {
    const { monitor, state, clock, send, store, api, options } = setup()
    state.current = status({ scheduled_reset: scheduled({ scheduled_for: null }), active_watch: watch({ reset_chance_percent: 100 }) })
    await monitor.subscribe(target())
    await monitor.poll()
    expect(send.mock.calls[0]?.[1]).toContain('未给出预定时间')
    clock.advance(60_000)
    state.current = status({ latest_reset: reset({ id: scheduled().id, announced_at: scheduled().announced_at }) })
    const restarted = new Monitor(store, api, send, options)
    await restarted.poll()
    await restarted.poll()
    expect(send.mock.calls.map(([, message]) => message.split('\n')[0])).toEqual(['【Codex 重置预告】', '【Codex 已执行重置】'])
    expect([...store.deliveries.values()].map(row => row.eventKey)).toEqual(['scheduled:regular:scheduled-1', 'reset:regular:scheduled-1'])
  })

  it('does not treat a forecast as a replacement for a withdrawn announcement', async () => {
    const { monitor, state, clock, send, store } = setup()
    state.current = status({ scheduled_reset: scheduled() })
    await monitor.subscribe(target())
    send.mockRejectedValueOnce(new Error('offline'))
    await monitor.poll()
    clock.advance(60_000)
    state.current = status({ active_watch: watch({ reset_chance_percent: 100 }) })
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(1)
    expect(store.deliveries.size).toBe(0)
    expect((await store.subscription(target().id))?.pendingResets).toHaveLength(1)
  })

  it.each(['kind', 'key', 'payload'] as const)('discards a legacy forecast recognized by %s even if the status API fails', async shape => {
    const { monitor, api, store, send } = setup()
    await monitor.subscribe(target())
    const subscription = (await store.subscriptions())[0]!
    await store.enqueue({ id: 'old-forecast', subscriptionId: subscription.id, generation: subscription.generation,
      kind: shape === 'kind' ? 'watch' : 'reset', eventKey: shape === 'key' ? 'watch:legacy' : 'legacy',
      payload: shape === 'payload' ? { type: 'watch', watch: watch() } : null, content: 'retired prediction',
      expiresAt: NOW + 3600_000, createdAt: NOW, retryAt: 0, attempts: 0, sentAt: 0 })
    api.status.mockRejectedValueOnce(new Error('upstream unavailable'))
    await expect(monitor.poll()).rejects.toThrow('upstream unavailable')
    await monitor.drain()
    expect(send).not.toHaveBeenCalled()
    expect(store.deliveries.size).toBe(0)
  })

  it('does not announce an already executed event or backfill it to a new subscriber when status fields conflict', async () => {
    const { monitor, state, send } = setup()
    state.current = status({ latest_reset: reset(), scheduled_reset: scheduled({ id: reset().id }) })
    await monitor.subscribe(target())
    await monitor.poll()
    expect(send).not.toHaveBeenCalled()
  })

  it('prefers execution evidence from history over an outdated scheduled field', async () => {
    const { monitor, state, api, clock, send, store } = setup()
    await monitor.subscribe(target())
    await monitor.poll()
    clock.advance(60_000)
    const executed = reset({ ...scheduled(), announced_at: new Date(NOW + 1000).toISOString() })
    state.current = status({ latest_reset: reset({ id: 'newer', announced_at: new Date(NOW + 2000).toISOString() }), scheduled_reset: scheduled() })
    api.history.mockResolvedValueOnce({ data: [executed], pagination: { has_more: false, next_cursor: null } })
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(2)
    expect([...store.deliveries.values()].every(row => row.kind === 'reset')).toBe(true)
  })

  it.each(locales)('localizes banked announcements with unknown scheduled time and no probability in %s', locale => {
    const output = formatScheduled(scheduled({ reset_type: 'banked', scheduled_for: null }), locale)
    expect(output).toContain(text(locale, 'scheduledTitle'))
    expect(output).toContain(text(locale, 'resetType', { value: text(locale, 'banked') }))
    expect(output).toContain(text(locale, 'noSchedule'))
    expect(output).not.toContain('%')
    expect(output).not.toMatch(/undefined|\{\w+\}/)
    expect(() => formatNotification({ type: 'watch', watch: watch() }, locale)).toThrow('Legacy forecast')
  })
})
