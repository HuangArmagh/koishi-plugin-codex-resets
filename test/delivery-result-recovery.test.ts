import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Monitor, resetKey } from '../src/monitor'
import type { Delivery, ResetType, Subscription } from '../src/types'
import { hash } from '../src/util'
import { makeApi, makeClock, NOW, reset, scheduled, target } from './helpers'

const require = createRequire(import.meta.url)
const { App } = require('koishi') as typeof import('koishi')
const Memory = require('@minatojs/driver-memory').default
const { defineModels, KoishiStore } = require('../lib/store') as typeof import('../src/store')

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

async function setup(type: 'channel' | 'private' = 'private', kind: 'scheduled' | 'reset' = 'reset', resetType: ResetType = 'regular') {
  const app = new App()
  app.plugin(Memory)
  app.plugin({ inject: ['database'], apply(ctx) { defineModels(ctx) } })
  await app.start()
  const store = new KoishiStore(app), clock = makeClock(), controller = new AbortController()
  const { api, state } = makeApi(), report = vi.fn()
  const destination = target('recipient', type, 'bot', 'qq'), healthy = target('healthy', type, 'bot', 'qq')
  const send = vi.fn(async (_target: Subscription, _content: string): Promise<void | boolean> => {})
  const options = { clock, signal: controller.signal, sendDelayMs: 1000, report }
  const monitor = new Monitor(store, api, send, options)
  await monitor.subscribe(destination)
  await monitor.poll()
  clock.advance(300_000)
  const event = reset({ id: '200', reset_type: resetType, announced_at: new Date(clock.now()).toISOString() })
  if (kind === 'reset') state.current.data.latest_reset = event
  else state.current.data.scheduled_reset = scheduled(event)
  const fault = { enabled: true, afterWrite: false, writes: 0 }
  const set = app.database.set.bind(app.database)
  vi.spyOn(app.database, 'set').mockImplementation(async (table, query, update) => {
    if (table === 'codex_reset_delivery' && typeof update.sentAt === 'number' && update.sentAt > 0) {
      const row = (await app.database.get('codex_reset_delivery', query))[0]
      if (row?.subscriptionId === destination.id) {
        fault.writes++
        if (fault.enabled) {
          if (fault.afterWrite) await set(table, query, update)
          throw new Error('temporary result write failure')
        }
      }
    }
    return set(table, query, update)
  })
  const rows = () => app.database.get('codex_reset_delivery', { subscriptionId: destination.id })
  return { app, store, clock, controller, api, state, report, destination, healthy, send, options, monitor, event, fault, rows }
}

describe('confirmed sends retry persistence without resubmitting messages', () => {
  it.each([
    ['channel', 'scheduled', 'regular'], ['private', 'scheduled', 'regular'],
    ['channel', 'reset', 'regular'], ['private', 'reset', 'regular'],
    ['channel', 'scheduled', 'banked'], ['private', 'scheduled', 'banked'],
    ['channel', 'reset', 'banked'], ['private', 'reset', 'banked'],
  ] as const)('recovers %s %s %s success after repeated write failures', async (type, kind, resetType) => {
    const c = await setup(type, kind, resetType)
    try {
      await c.monitor.poll()
      const acknowledgedAt = c.clock.now()
      expect(c.send).toHaveBeenCalledTimes(1)
      expect((await c.rows())[0]).toMatchObject({ sentAt: 0, attempts: 0, retryAt: 0 })
      for (let index = 0; index < 2; index++) { c.clock.advance(300_000); await c.monitor.poll() }
      expect(c.send).toHaveBeenCalledTimes(1)
      expect(c.fault.writes).toBeGreaterThan(1)
      expect(c.report.mock.calls.every(([message]) => !message.includes('推送失败'))).toBe(true)
      expect(c.report.mock.calls.some(([message]) => message.includes('消息已发送') && message.includes('保存失败'))).toBe(true)
      c.fault.enabled = false
      await c.monitor.drain()
      expect((await c.rows())[0]).toMatchObject({ sentAt: acknowledgedAt, attempts: 0, retryAt: 0 })
      c.clock.advance(300_000)
      await new Monitor(new KoishiStore(c.app), c.api, c.send, c.options).poll()
      expect(c.send).toHaveBeenCalledTimes(1)
    } finally { await c.app.stop() }
  })

  it('recognizes a committed success even if the database acknowledgement failed', async () => {
    const c = await setup()
    try {
      c.fault.afterWrite = true
      await c.monitor.poll()
      expect((await c.rows())[0]).toMatchObject({ sentAt: c.clock.now(), attempts: 0, retryAt: 0 })
      await c.monitor.drain()
      expect(c.fault.writes).toBe(1)
      expect(c.send).toHaveBeenCalledTimes(1)
      expect(c.report.mock.calls.every(([message]) => !message.includes('推送失败'))).toBe(true)
    } finally { await c.app.stop() }
  })

  it('isolates a pending success from other conversations and defers its own next message', async () => {
    const c = await setup()
    try {
      await c.monitor.subscribe(c.healthy)
      await c.monitor.poll()
      expect(c.send.mock.calls.map(([target]) => target.id)).toEqual([c.destination.id, c.healthy.id])
      c.clock.advance(300_000)
      c.state.current.data.latest_reset = reset({ id: '300', announced_at: new Date(c.clock.now()).toISOString() })
      await c.monitor.poll()
      expect(c.send.mock.calls.map(([target]) => target.id)).toEqual([c.destination.id, c.healthy.id, c.healthy.id])
      c.fault.enabled = false
      await c.monitor.drain()
      expect(c.send.mock.calls.map(([target]) => target.id)).toEqual([c.destination.id, c.healthy.id, c.healthy.id, c.destination.id])
      expect((await c.rows()).every(row => row.sentAt > 0)).toBe(true)
    } finally { await c.app.stop() }
  })

  it('does not resurrect a cancelled generation or block its replacement subscription', async () => {
    const c = await setup()
    try {
      await c.monitor.poll()
      const old = (await c.rows())[0]!
      await c.monitor.unsubscribe(c.destination)
      await c.monitor.subscribe(c.destination)
      c.clock.advance(300_000)
      c.fault.enabled = false
      c.state.current.data.latest_reset = reset({ id: '300', announced_at: new Date(c.clock.now()).toISOString() })
      await c.monitor.poll()
      expect(c.send).toHaveBeenCalledTimes(2)
      expect(await c.store.delivery(old.id)).toBeUndefined()
      expect((await c.rows()).every(row => row.generation !== old.generation && row.sentAt > 0)).toBe(true)
    } finally { await c.app.stop() }
  })

  it('retains a confirmed announcement after withdrawal deletes its unsaved row', async () => {
    const c = await setup('private', 'scheduled')
    try {
      await c.monitor.poll()
      const old = (await c.rows())[0]!, announcement = c.state.current.data.scheduled_reset
      const acknowledgedAt = c.clock.now()
      c.clock.advance(300_000)
      c.state.current.data.scheduled_reset = null
      await c.monitor.poll()
      c.fault.enabled = false
      await c.monitor.drain()
      expect(await c.store.delivery(old.id)).toMatchObject({ sentAt: acknowledgedAt })
      c.state.current.data.scheduled_reset = announcement
      c.clock.advance(300_000)
      await c.monitor.poll()
      expect(c.send).toHaveBeenCalledTimes(1)
    } finally { await c.app.stop() }
  })

  it('prevents an older queued alias from overtaking an acknowledged execution awaiting persistence', async () => {
    const c = await setup()
    try {
      await c.monitor.poll()
      const original = (await c.rows())[0]!
      const observed = { ...c.event, id: 'observed-200', source: { type: 'observed' as const } }
      const duplicate: Delivery = { ...original, id: hash([original.subscriptionId, original.generation, resetKey(observed)]),
        eventKey: resetKey(observed), createdAt: original.createdAt - 1000, payload: { type: 'reset', reset: observed } }
      await c.store.enqueue(duplicate)
      c.state.current.data.latest_reset = observed
      c.clock.advance(300_000)
      await c.monitor.poll()
      expect(c.send).toHaveBeenCalledTimes(1)
      c.fault.enabled = false
      await c.monitor.drain()
      expect(await c.store.delivery(original.id)).toMatchObject({ sentAt: original.createdAt })
      expect(await c.store.delivery(duplicate.id)).toBeUndefined()
      expect(c.send).toHaveBeenCalledTimes(1)
    } finally { await c.app.stop() }
  })

  it('flushes acknowledged results during API backoff without issuing API requests', async () => {
    const c = await setup()
    try {
      await c.monitor.poll()
      Object.assign(c.api, { retryAt: c.clock.now() + 600_000 })
      const statusCalls = c.api.status.mock.calls.length, historyCalls = c.api.history.mock.calls.length
      c.fault.enabled = false
      await c.monitor.drain()
      expect((await c.rows())[0]!.sentAt).toBeGreaterThan(0)
      expect(c.send).toHaveBeenCalledTimes(1)
      expect(c.api.status).toHaveBeenCalledTimes(statusCalls)
      expect(c.api.history).toHaveBeenCalledTimes(historyCalls)
    } finally { await c.app.stop() }
  })

  it('preserves normal adapter-failure retries and ignores skipped submissions', async () => {
    const c = await setup()
    try {
      c.fault.enabled = false
      c.send.mockRejectedValueOnce(new Error('adapter rejected message')).mockResolvedValueOnce(false)
      await c.monitor.poll()
      expect((await c.rows())[0]).toMatchObject({ sentAt: 0, attempts: 1, retryAt: c.clock.now() + 30_000 })
      c.clock.advance(300_000)
      await c.monitor.drain()
      expect((await c.rows())[0]!.sentAt).toBe(0)
      await c.monitor.drain()
      expect(c.send).toHaveBeenCalledTimes(3)
      expect((await c.rows())[0]!.sentAt).toBeGreaterThan(0)
      expect(c.report.mock.calls.filter(([message]) => message.includes('推送失败'))).toHaveLength(1)
    } finally { await c.app.stop() }
  })

  it('preserves earlier failure attempts when a later successful send needs database recovery', async () => {
    const c = await setup()
    try {
      c.send.mockRejectedValueOnce(new Error('adapter rejected message'))
      await c.monitor.poll()
      const failed = (await c.rows())[0]!
      c.clock.advance(300_000)
      await c.monitor.drain()
      const acknowledgedAt = c.clock.now()
      c.clock.advance(300_000)
      await c.monitor.drain()
      expect(c.send).toHaveBeenCalledTimes(2)
      c.fault.enabled = false
      await c.monitor.drain()
      expect((await c.rows())[0]).toMatchObject({ sentAt: acknowledgedAt, attempts: failed.attempts, retryAt: failed.retryAt })
      expect(c.report.mock.calls.filter(([message]) => message.includes('推送失败'))).toHaveLength(1)
    } finally { await c.app.stop() }
  })

  it('retains success through a failed row recreation and announcement reappearance', async () => {
    const c = await setup('private', 'scheduled')
    try {
      await c.monitor.poll()
      const old = (await c.rows())[0]!, announcement = c.state.current.data.scheduled_reset
      const enqueue = c.store.enqueue.bind(c.store)
      vi.spyOn(c.store, 'enqueue').mockImplementation(async row => {
        if (row.sentAt) throw new Error('temporary result insert failure')
        return enqueue(row)
      })
      c.state.current.data.scheduled_reset = null
      c.clock.advance(300_000)
      await c.monitor.poll()
      expect(await c.store.delivery(old.id)).toBeUndefined()
      c.state.current.data.scheduled_reset = announcement
      c.clock.advance(300_000)
      await c.monitor.poll()
      expect(c.send).toHaveBeenCalledTimes(1)
      c.fault.enabled = false
      await c.monitor.drain()
      expect(await c.store.delivery(old.id)).toMatchObject({ sentAt: old.createdAt })
      expect(c.send).toHaveBeenCalledTimes(1)
    } finally { await c.app.stop() }
  })

  it('rechecks stale pending batches when late success cannot yet be saved', async () => {
    vi.useFakeTimers({ now: NOW })
    const c = await setup()
    let finish!: () => void
    try {
      c.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      const polling = c.monitor.poll()
      await vi.advanceTimersByTimeAsync(30_000)
      await polling
      const pending = c.store.pending.bind(c.store)
      vi.spyOn(c.store, 'pending').mockImplementationOnce(async now => {
        const stale = await pending(now)
        finish()
        await vi.advanceTimersByTimeAsync(0)
        return stale
      })
      await c.monitor.drain()
      expect(c.send).toHaveBeenCalledTimes(1)
      c.fault.enabled = false
      await c.monitor.drain()
      expect((await c.rows())[0]!.sentAt).toBeGreaterThan(0)
      expect(c.send).toHaveBeenCalledTimes(1)
    } finally { finish?.(); await c.app.stop() }
  })

  it('keeps a late successful outcome pending when its first database write fails', async () => {
    vi.useFakeTimers({ now: NOW })
    const c = await setup()
    let finish!: () => void
    try {
      c.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      const polling = c.monitor.poll()
      await vi.advanceTimersByTimeAsync(30_000)
      await polling
      finish()
      await vi.advanceTimersByTimeAsync(0)
      c.clock.advance(300_000)
      await c.monitor.drain()
      expect(c.send).toHaveBeenCalledTimes(1)
      c.fault.enabled = false
      await c.monitor.drain()
      expect((await c.rows())[0]!.sentAt).toBeGreaterThan(0)
      expect(c.send).toHaveBeenCalledTimes(1)
    } finally { finish?.(); await c.app.stop() }
  })
})
