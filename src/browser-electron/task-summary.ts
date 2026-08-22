/** Return a page-safe task location without path, query, or fragment data. */
export function taskSummaryUrl(raw: string): string {
  if (raw === '') return ''
  try {
    const origin = new URL(raw).origin
    return origin === 'null' ? '' : origin
  } catch {
    return ''
  }
}
