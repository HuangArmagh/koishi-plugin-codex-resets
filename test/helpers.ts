import { vi } from 'vitest'
import type { Api, ApiRequestState, Checkpoint, Clock, Delivery, ExecutionLink, Reset, ScheduledReset, StatusResponse, Store, Subscription, Target, Watch } from '../src/types'
import { isExecutionDelivery } from '../src/execution'
import { hash } from '../src/util'
import type { App } from 'koishi'

export const NOW = Date.parse('2026-10-25T04:00:00Z')

export function makeClock() {
  let now = NOW
  const delays: number[] = []
  return {
    now: () => now,
    advance: (ms: number) => { now += ms },
    sleep: async (ms: number, signal?: AbortSignal) => { signal?.throwIfAborted(); delays.push(ms); now += ms },
    delays,
  } satisfies Clock & { advance(ms: number): void; delays: number[] }
}

export function target(targetId = 'group-a', type: Target['type'] = 'channel', selfId = 'bot-a', platform = 'onebot'): Target {
  return { id: hash([platform, selfId, type, targetId]), platform, selfId, type, targetId, guildId: '' }
}

export function configureOneBotMock(app: App, role = 'admin') {
  const bot = app.bots[0]!
  bot.platform = 'onebot'
  const client = app.mock.client.bind(app.mock)
  app.mock.client = (userId: string, channelId?: string) => {
    const result = client(userId, channelId)
    result.event.platform = 'onebot'
    if (channelId) result.event.member = { user: { id: userId }, roles: [{ id: role }] }
    return result
  }
  app.mock.initUser = async (id, authority = 1, data = {}) => { await app.database.createUser('onebot', id, { authority, ...data }) }
  app.mock.initChannel = async (id, assignee = bot.selfId, data = {}) => { await app.database.createChannel('onebot', id, { assignee, ...data }) }
  return bot
}

export function reset(overrides: Partial<Reset> = {}): Reset {
  return {
    id: '2113492502355562875', reset_type: 'regular', announced_at: new Date(NOW - 3600_000).toISOString(),
    text: 'Codex usage limits have been reset.', source: { type: 'observed' }, ...overrides,
  }
}

export function watch(overrides: Partial<Watch> = {}): Watch {
  return {
    level: 'elevated', reset_chance_percent: 60, forecast_window: 'today',
    observed_at: new Date(NOW - 60_000).toISOString(), expires_at: new Date(NOW + 3600_000).toISOString(),
    text: 'Possible reset soon.', source: { type: 'observed' }, ...overrides,
  }
}

export function scheduled(overrides: Partial<ScheduledReset> = {}): ScheduledReset {
  return { ...reset({ id: 'scheduled-1', text: 'A reset has been announced.' }), status: 'scheduled',
    scheduled_for: new Date(NOW + 3600_000).toISOString(), ...overrides }
}

export function status(overrides: Partial<StatusResponse['data']> = {}): StatusResponse {
  return { data: {
    latest_reset: reset(), scheduled_reset: null, active_watch: null,
    stats: { total: 1, last_reset_at: new Date(NOW - 3600_000).toISOString(), days_since_last: null, avg_interval_days: null },
    ...overrides,
  }, meta: { api_version: 'v1', generated_at: new Date(NOW).toISOString() } }
}

export function makeApi(initial = status()) {
  const state = { current: initial }
  const api = {
    status: vi.fn(async () => state.current),
    history: vi.fn<Api['history']>(async () => ({ data: [], pagination: { has_more: false, next_cursor: null } })),
    recent: vi.fn<Api['recent']>(async () => ({ data: [], pagination: { has_more: false, next_cursor: null } })),
  } satisfies Api
  return { api, state }
}

// Exercise both API routes when integration tests initialize a real plugin.
export function apiHttpResponse(url: string, snapshot: StatusResponse) {
  const body = new URL(url).pathname.endsWith('/status') ? snapshot
    : { data: [], pagination: { has_more: false, next_cursor: null } }
  return { status: 200, headers: new Headers(), data: JSON.stringify(body) }
}

export class MemoryStore implements Store {
  readonly subs = new Map<string, Subscription>()
  readonly deliveries = new Map<string, Delivery>()
  readonly executions = new Set<string>()
  readonly links = new Map<string, ExecutionLink>()
  state: Checkpoint | null = null
  requestState: ApiRequestState | null = null

  async subscriptions() { return structuredClone([...this.subs.values()]) }
  async subscription(id: string) { return structuredClone(this.subs.get(id)) }
  async saveSubscription(value: Subscription) { this.subs.set(value.id, structuredClone(value)) }
  async deleteSubscription(id: string) {
    this.subs.delete(id)
    for (const [key, delivery] of this.deliveries) if (delivery.subscriptionId === id) this.deliveries.delete(key)
  }
  async checkpoint() { return structuredClone(this.state) }
  async saveCheckpoint(value: Checkpoint) { this.state = structuredClone(value) }
  async enqueue(value: Delivery) {
    const existing = this.deliveries.get(value.id)
    if (!existing) this.deliveries.set(value.id, structuredClone(value))
    else if (!existing.sentAt && existing.kind === 'scheduled' && value.eventKey.startsWith('scheduled:')) {
      Object.assign(existing, { content: value.content, expiresAt: value.expiresAt, payload: value.payload ?? null })
    }
  }
  async pending(now: number) { return structuredClone([...this.deliveries.values()].filter(value => !value.sentAt && value.retryAt <= now)) }
  async delivery(id: string) { return structuredClone(this.deliveries.get(id)) }
  async executionDeliveries(subscriptionId: string, generation: string, eventKeys: string[]) {
    return structuredClone([...this.deliveries.values()].filter(value => value.subscriptionId === subscriptionId
      && value.generation === generation && eventKeys.includes(value.eventKey) && isExecutionDelivery(value)))
  }
  async updateDelivery(id: string, changes: Partial<Delivery>) {
    const value = this.deliveries.get(id)
    if (value) Object.assign(value, changes)
  }
  async deleteDelivery(id: string) { this.deliveries.delete(id) }
  async cancelScheduledExcept(activeKey: string | null) {
    for (const [id, delivery] of this.deliveries) {
      if (!delivery.sentAt && delivery.kind === 'scheduled' && delivery.eventKey !== activeKey) this.deliveries.delete(id)
    }
  }
  async apiState() { return structuredClone(this.requestState) }
  async saveApiState(value: ApiRequestState) { this.requestState = structuredClone(value) }
  async hasExecution(key: string) { return this.executions.has(key) }
  async executionKeys() { return [...this.executions] }
  async executionLinks() { return structuredClone([...this.links.values()]) }
  async saveExecutions(keys: string[], links: ExecutionLink[] = []) {
    for (const key of keys) this.executions.add(key)
    for (const link of links) {
      this.links.set(link.observedKey, structuredClone(link))
      this.executions.add(link.observedKey)
      this.executions.add(link.originalKey)
    }
  }
}

let fixtureId = 0
export async function enqueueResetFixtures(store: Store, destination: Target, count = 2, now = NOW) {
  const subscription = await store.subscription(destination.id)
  if (!subscription) throw new Error('Fixture requires an existing subscription')
  for (let index = 0; index < count; index++) {
    const id = 'fixture-reset-' + ++fixtureId
    await store.enqueue({ id, subscriptionId: destination.id, generation: subscription.generation,
      eventKey: 'reset:regular:' + id, kind: 'reset', content: 'Fixture ' + id, createdAt: now,
      expiresAt: 0, retryAt: 0, attempts: 0, sentAt: 0,
    })
  }
}
