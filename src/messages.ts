// Account for the official Discord adapter's Markdown escaping, in UTF-16 units.
const escaped = /[\\*_\u0060~|()\[\]]/
const cost = (character: string) => character.length + Number(escaped.test(character))

function neutralizeMentions(value: string): string {
  return value.replace(/<@(?=[!&]?\d+>)/g, '<@\u200b')
    .replace(/@(everyone|here)/g, '@\u200b$1')
}

export function discordTextLength(value: string): number {
  let length = 0
  for (const character of neutralizeMentions(value)) length += cost(character)
  return length
}

export function clipDiscordText(value: string, budget = 2000): string {
  const safe = neutralizeMentions(value)
  if (discordTextLength(safe) <= budget) return safe
  let length = 0, result = ''
  for (const character of safe) {
    const next = cost(character)
    if (length + next > budget - 1) break
    result += character
    length += next
  }
  return result + '…'
}

// Telegram counts text after HTML entity parsing. UTF-16 is conservative for emoji.
export function clipText(value: string, budget: number): string {
  if (value.length <= budget) return value
  let result = ''
  for (const character of value) {
    if (result.length + character.length > budget - 1) break
    result += character
  }
  return result + '…'
}

export function messageContent(content: string, platform = ''): string {
  // Callers still wrap the result in h.text to prevent Koishi element injection.
  if (platform === 'discord') return clipDiscordText(content)
  if (platform === 'telegram') return clipText(content, 4096)
  return content
}
