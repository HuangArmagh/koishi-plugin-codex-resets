import type { Session } from 'koishi'

export type ManagementAccess = 'allowed' | 'denied' | 'unavailable'

function roleAccess(value: unknown, allowed: string[], ordinary: string[]): ManagementAccess {
  if (typeof value !== 'string') return 'unavailable'
  if (allowed.includes(value)) return 'allowed'
  return ordinary.includes(value) ? 'denied' : 'unavailable'
}

function permissionBits(value: unknown): bigint | undefined {
  if (typeof value === 'bigint' && value >= 0n) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
}

/** Platform identities are authoritative; Koishi authority and role display names cannot grant access. */
export async function managementAccess(session: Session): Promise<ManagementAccess> {
  if (session.isDirect) return 'allowed'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      checkGroupAccess(session),
      new Promise<ManagementAccess>(resolve => { timer = setTimeout(() => resolve('unavailable'), 15_000) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function checkGroupAccess(session: Session): Promise<ManagementAccess> {
  const { guildId, userId, bot, platform } = session
  if (!guildId || !userId) return 'unavailable'
  try {
    if (platform === 'onebot') {
      // OneBot maps the protocol's sender.role to the member's role ID.
      const member = session.event.member?.roles?.length ? session.event.member : await bot.getGuildMember(guildId, userId)
      if (member?.user?.id && member.user.id !== userId) return 'unavailable'
      const roles = member?.roles
      if (!roles?.length) return 'unavailable'
      const results = roles.map(role => roleAccess(role.id, ['owner', 'admin'], ['member']))
      return results.includes('allowed') ? 'allowed' : results.every(value => value === 'denied') ? 'denied' : 'unavailable'
    }
    if (platform === 'telegram') {
      // The Telegram adapter's normalized GuildMember omits administrator status.
      if (typeof bot.internal?.getChatMember !== 'function' || !/^\d+$/.test(userId)) return 'unavailable'
      const id = Number(userId)
      if (!Number.isSafeInteger(id)) return 'unavailable'
      const member = await bot.internal.getChatMember({ chat_id: guildId, user_id: id })
      if (String(member?.user?.id) !== userId) return 'unavailable'
      return roleAccess(member.status, ['creator', 'administrator'], ['member', 'restricted', 'left', 'kicked'])
    }
    if (platform === 'discord') {
      const internal = bot.internal
      if (typeof internal?.getGuild !== 'function') return 'unavailable'
      const guild = await internal.getGuild(guildId)
      if (guild?.id !== guildId || typeof guild.owner_id !== 'string') return 'unavailable'
      if (guild.owner_id === userId) return 'allowed'
      if (typeof internal.getGuildMember !== 'function' || typeof internal.getGuildRoles !== 'function') return 'unavailable'
      const member = await internal.getGuildMember(guildId, userId)
      if (member?.user?.id !== userId || !Array.isArray(member.roles) || !member.roles.every((id: unknown) => typeof id === 'string')) return 'unavailable'
      const roles = await internal.getGuildRoles(guildId)
      if (!Array.isArray(roles)) return 'unavailable'
      const ids = new Set<string>([guildId, ...member.roles]) // Include @everyone, whose ID is the guild ID.
      let permissions = 0n
      for (const id of ids) {
        const bits = permissionBits(roles.find(role => role?.id === id)?.permissions)
        if (bits === undefined) return 'unavailable'
        permissions |= bits
      }
      return permissions & 8n ? 'allowed' : 'denied'
    }
    // Other adapters must supply a platform-specific check before group mutations are supported.
    return 'unavailable'
  } catch {
    return 'unavailable'
  }
}
