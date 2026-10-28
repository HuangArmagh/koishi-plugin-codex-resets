import type { Locale } from './locales'
export type ResetType = 'regular' | 'banked'

export interface Source {
  type: 'x_post' | 'observed'
  url?: string
  author?: string
}

export interface Reset {
  id: string
  reset_type: ResetType
  announced_at: string
  text: string
  source: Source
}

export interface Watch {
  level: 'elevated' | 'strong'
  reset_chance_percent: number | null
  forecast_window: string
  observed_at: string
  expires_at: string
  text: string
  source: Source
}

export interface ScheduledReset extends Reset {
  status: 'scheduled'
  scheduled_for: string | null
}

export interface StatusResponse {
  data: {
    latest_reset: Reset | null
    scheduled_reset: ScheduledReset | null
    active_watch: Watch | null
    stats: {
      total: number
      last_reset_at: string | null
      days_since_last: number | null
      avg_interval_days: number | null
    }
  }
  meta: { api_version: 'v1'; generated_at: string }
}

export interface ResetListResponse {
  data: Reset[]
  pagination: { has_more: boolean; next_cursor: string | null }
}

export interface Target {
  id: string
  platform: string
  selfId: string
  type: 'channel' | 'private'
  targetId: string
  guildId: string
}

export interface Subscription extends Target {
  locale?: Locale | ''
  generation: string
  subscribedAt: number
  baselined: boolean
  baselineResetKey: string
  /** Executions known at registration or excluded by a complete initial history check. */
  baselineExecutionKeys?: string[] | null
  pendingResets?: { key: string; announcedAt: string }[]
}

export interface Checkpoint {
  latestResetKey: string | null
  latestResetAt: string | null
  checkedAt: number
}

export interface ExecutionLink {
  observedKey: string
  originalKey: string
}

export interface Delivery {
  id: string
  subscriptionId: string
  generation: string
  eventKey: string
  /** watch is read only for discarding legacy forecast deliveries. */
  kind: 'reset' | 'scheduled' | 'watch'
  content: string
  payload?: Notification | null
  createdAt: number
  expiresAt: number
  retryAt: number
  attempts: number
  sentAt: number
}

export interface ApiRequestState {
  lastRequestAt: number
  blockedUntil: number
  failures: number
  /** Optional when reading persisted records without a request marker. */
  requestPending?: boolean
}

export interface Notification {
  /** Legacy watch/test types are read only for discarding old queued messages. */
  type: 'reset' | 'scheduled' | 'watch' | 'test'
  reset?: Reset
  scheduled?: ScheduledReset
  watch?: Watch
  kind?: 'watch' | 'reset'
  at?: number
}

export interface ApiStateStore {
  apiState(): Promise<ApiRequestState | null>
  saveApiState(value: ApiRequestState): Promise<void>
}

export interface Store extends ApiStateStore {
  subscriptions(): Promise<Subscription[]>
  subscription(id: string): Promise<Subscription | undefined>
  saveSubscription(value: Subscription): Promise<void>
  deleteSubscription(id: string): Promise<void>
  checkpoint(): Promise<Checkpoint | null>
  saveCheckpoint(value: Checkpoint): Promise<void>
  enqueue(delivery: Delivery): Promise<void>
  pending(now: number): Promise<Delivery[]>
  delivery(id: string): Promise<Delivery | undefined>
  executionDeliveries(subscriptionId: string, generation: string, eventKeys: string[]): Promise<Delivery[]>
  updateDelivery(id: string, changes: Partial<Delivery>): Promise<void>
  deleteDelivery(id: string): Promise<void>
  cancelScheduledExcept(activeKey: string | null): Promise<void>
  hasExecution(eventKey: string): Promise<boolean>
  executionKeys(): Promise<string[]>
  executionLinks(): Promise<ExecutionLink[]>
  saveExecutions(eventKeys: string[], links?: ExecutionLink[]): Promise<void>
}

export interface Api {
  readonly retryAt?: number
  status(minRequestedAt?: number): Promise<StatusResponse>
  history(from: string, cursor?: string, limit?: number): Promise<ResetListResponse>
  recent(): Promise<ResetListResponse>
}

export interface Clock {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}
