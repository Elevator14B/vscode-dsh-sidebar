/** A bounded startup diagnosis; the complete output stays in the host and log. */
export function summarizeStartupError(message: string): string {
  if (message.includes('client bundles not found') || message.includes('client bundle not found')) {
    return 'DSH is missing built frontend files. If using a source checkout, run pnpm run build there; otherwise repair the DSH installation. Open the log for the missing package paths.'
  }
  const lines = message.replace(/\u001b\[[0-9;]*m/gu, '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  const cause = lines.find(line => /^(?:[\w.]*Error|error):/u.test(line)) ?? lines[0] ?? 'Unknown startup error.'
  return cause.length > 400 ? `${cause.slice(0, 399)}…` : cause
}
