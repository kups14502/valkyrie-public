/**
 * One real headless Claude answer through lib/claudeCli.ts (pool tokens, then profiles), to prove the
 * credential path works on this host. Prints which answer came back and how long it took; files
 * nothing and touches no data.
 *   node --import tsx scripts/assistProbe.mts
 */
const { askClaude, extractJson, nyNowLine } = await import('../src/lib/claudeCli.ts')
const t0 = Date.now()
const answer = await askClaude([
  `Now: ${nyNowLine()}.`,
  'Classify this note and answer with ONE JSON object only: {"kind":"task|reminder|event|note","text":"","due":null}.',
  'due is YYYY-MM-DD New York time when a day is named, else null.',
  'The note: """pick up the dry cleaning on friday"""',
].join('\n'), { timeoutMs: 90_000 })
console.log('answer', JSON.stringify(extractJson(answer)), `${Date.now() - t0} ms`)
process.exit(0)
