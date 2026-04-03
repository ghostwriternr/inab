const MAX_TOKENS = 6000
const CHARS_PER_TOKEN = 4
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN

export function truncateContent(content: unknown): string {
  if (content === null) return 'null'
  if (content === undefined) return 'undefined'

  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2)

  if (text.length <= MAX_CHARS) {
    return text
  }

  const truncated = text.slice(0, MAX_CHARS)
  return `${truncated}\n\n--- TRUNCATED ---\nResponse was truncated (original size: ${text.length} characters, ~${Math.ceil(text.length / CHARS_PER_TOKEN)} tokens). Write a more specific query to get smaller results (e.g., filter by date, account, or category; use server_knowledge for delta requests).`
}
