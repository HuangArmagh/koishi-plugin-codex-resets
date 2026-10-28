import type { Delivery, ExecutionLink, Reset } from './types'

export function resetKey(reset: Reset): string {
  return `reset:${reset.reset_type}:${reset.id}`
}

export function executionLink(reset: Reset): ExecutionLink | undefined {
  const match = reset.source.type === 'observed' && /^observed-([0-9]+)$/.exec(reset.id)
  if (match) return { observedKey: resetKey(reset), originalKey: `reset:${reset.reset_type}:${match[1]}` }
}

export function isExecutionDelivery(delivery: Delivery): boolean {
  return delivery.kind === 'reset' && (!delivery.payload || delivery.payload.type === 'reset')
}

// A prefix alone is not evidence. Only links confirmed by an observed Reset (or
// restored from its validated payload) may join two otherwise independent IDs.
export class ExecutionIdentity {
  private readonly related = new Map<string, string>()
  private readonly canonical = new Map<string, string>()

  constructor(links: ExecutionLink[] = []) {
    for (const link of links) this.add(link)
  }

  private add({ observedKey, originalKey }: ExecutionLink): void {
    this.related.set(observedKey, originalKey)
    this.related.set(originalKey, observedKey)
    this.canonical.set(observedKey, originalKey)
  }

  observe(reset: Reset): void {
    const link = executionLink(reset)
    if (link) this.add(link)
  }

  keys(key: string): string[] {
    const related = this.related.get(key)
    return related ? [key, related] : [key]
  }

  key(key: string): string { return this.canonical.get(key) ?? key }

  includes(keys: Iterable<string>, key: string): boolean {
    const canonical = this.key(key)
    for (const candidate of keys) if (this.key(candidate) === canonical) return true
    return false
  }
}
