/**
 * Projects store smoke test.
 *
 * Drives lib/projectsStore.ts directly, with no HTTP and no tmux: tabs, the
 * baseRev rules, file pins, runs and their one-shot brief, session links, the
 * event log with undo and revert-by-session, the change long-poll, the rate
 * limits and reminders through a fake lilkups.
 *
 * Runs on odin only (better-sqlite3 has no Windows build on thor), against a
 * scratch data dir, never the live one:
 *   T=$(mktemp -d)
 *   printf '#!/bin/bash\nif [ "$2" = add ]; then echo "abcd1234  x  user:0  fake"; else echo "removed abcd1234"; fi\n' > $T/lk
 *   chmod +x $T/lk
 *   VALKYRIE_DATA_DIR=$T LILKUPS_BIN=$T/lk node --import tsx scripts/projSmoke.mts
 *   rm -rf $T
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import type { ChecklistItem, Ctx } from '../src/lib/projectTypes.js'

const LIVE_DIR = path.join(homedir(), 'valkyrie', 'backend', 'data')
const real = (p: string) => {
  try { return fs.realpathSync(p) } catch { return path.resolve(p) }
}
const dataDir = process.env.VALKYRIE_DATA_DIR
if (!dataDir || real(dataDir) === real(LIVE_DIR) || !process.env.LILKUPS_BIN) {
  console.error('projSmoke: set VALKYRIE_DATA_DIR to a scratch directory (never the live data dir) and LILKUPS_BIN to a fake lilkups')
  process.exit(2)
}
// Reminder states are read from here. Kept inside the scratch dir unless the
// operator says otherwise, so the run never even reads the real list.
process.env.LILKUPS_STORE ||= path.join(dataDir, 'reminders.json')

// Imported only now: the store opens its database, and lilkups.ts reads its
// paths, at import time.
const S = await import('../src/lib/projectsStore.js')
const { addLilkupsReminder } = await import('../src/lib/lilkups.js')

const UI: Ctx = { actor: 'ui', via: 'ui' }
const TERM: Ctx = { actor: 'ui', via: 'terminal' }
const SID = '11111111-2222-3333-4444-555555555555'
const SESSION: Ctx = { actor: `session:${SID}`, via: 'mcp' }
const OTHER: Ctx = { actor: 'session:99999999-8888-7777-6666-555555555555', via: 'mcp' }
const HOOK: Ctx = { actor: `hook:${SID}`, via: 'hook' }
const TMUX = 'vk-0123456789'

type Thrown = { status?: number; message?: string; body?: Record<string, unknown> }

function fails(status: number, fn: () => unknown): Record<string, unknown> | undefined {
  try {
    fn()
  } catch (err) {
    const e = err as Thrown
    assert.equal(e.status, status, `expected ${status}, got ${e.status}: ${e.message}`)
    return e.body
  }
  assert.fail(`expected a ${status}`)
}

async function failsAsync(status: number, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    const e = err as Thrown
    assert.equal(e.status, status, `expected ${status}, got ${e.status}: ${e.message}`)
    return
  }
  assert.fail(`expected a ${status}`)
}

const ok = (what: string) => console.log(`ok  ${what}`)
const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString()

// ------------------------------------------------------------ project ----

const a = S.createProject({ name: 'smoke', area: 'personal', targetKey: 'vk-smoke' }, UI)
assert.equal(a.exposure, 'anywhere')
assert.equal(a.allowSnapshots, true)
let doc = await S.getProjectDoc(a.id)
assert.equal(doc.tabs.length, 1)
const notes = doc.tabs[0]
assert.equal(notes.kind, 'markdown')
assert.equal(notes.title, 'notes')
assert.equal(notes.body, '')
ok('a new personal project is seeded with a notes tab')

// ---------------------------------------------------------- checklist ----

const todo = S.addTab(a.id, { kind: 'checklist', title: 'todo', items: ['one', 'two'] }, UI)
assert.equal(todo.items.length, 2)
const first = todo.items[0] as ChecklistItem
const checked = S.tabItem(a.id, todo.id, { op: 'set', itemId: first.id, done: true }, UI)
const c0 = checked.items[0] as ChecklistItem
assert.equal(c0.done, true)
assert.ok(c0.doneAt)
assert.equal(checked.rev, todo.rev + 1)
fails(404, () => S.tabItem(a.id, todo.id, { op: 'set', itemId: 'nope', done: true }, UI))
ok('checklist tab with 2 items, item set')

// ----------------------------------------------------- baseRev rules ----

const stale = fails(409, () => S.updateTab(a.id, notes.id, { baseRev: notes.rev + 5, body: 'x' }, UI))
assert.equal((stale?.current as { id?: string } | undefined)?.id, notes.id)
ok('stale baseRev gives 409 with the current tab')

fails(400, () => S.updateTab(a.id, notes.id, { body: 'x' }, SESSION))
ok('a session replacing a body without baseRev gives 400')

S.updateTab(a.id, notes.id, { appendBody: 'first' }, SESSION)
const appended = S.updateTab(a.id, notes.id, { appendBody: 'second' }, SESSION)
assert.equal(appended.body, 'first\n\nsecond')
const grown = S.updateTab(a.id, todo.id, { appendBody: '- three\n\nfour' }, SESSION)
assert.deepEqual((grown.items as ChecklistItem[]).map((i) => i.text), ['one', 'two', 'three', 'four'])
const links = S.addTab(a.id, { kind: 'links', title: 'links', items: [{ label: 'site', url: 'https://example.com' }] }, UI)
fails(400, () => S.updateTab(a.id, links.id, { appendBody: 'x' }, SESSION))
ok('tab_append on markdown and checklist, refused on links')

// -------------------------------------------------------------- files ----

S.pinFile(a.id, { kind: 'path', label: 'readme', relPath: 'docs/readme.md' }, UI)
const repinned = S.pinFile(a.id, { kind: 'path', label: 'readme', relPath: 'docs\\readme.md', content: '# hi' }, SESSION)
doc = await S.getProjectDoc(a.id)
assert.equal(doc.files.filter((f) => f.relPath === 'docs/readme.md').length, 1)
assert.equal(repinned.hasContent, true)
assert.equal(repinned.contentType, 'markdown')
assert.equal(S.getFileContent(a.id, repinned.id).content, '# hi')
fails(400, () => S.pinFile(a.id, { kind: 'path', label: 'x', relPath: '../outside' }, UI))
fails(400, () => S.pinFile(a.id, { kind: 'path', label: 'x', relPath: 'C:/Windows' }, UI))
fails(400, () => S.pinFile(a.id, { kind: 'url', label: 'x', url: '//elsewhere.example/x' }, UI))
ok('pinning the same relPath twice leaves one row')

const w = S.createProject({ name: 'smoke work', area: 'work', targetKey: 'vk-smoke' }, UI)
assert.equal(w.exposure, 'tailnet')
assert.equal(w.allowSnapshots, false)
fails(403, () => S.pinFile(w.id, { kind: 'doc', label: 'doc', content: 'text' }, UI))
fails(403, () => S.pinFile(w.id, { kind: 'path', label: 'p', relPath: 'a.txt', content: 'text' }, UI))
S.pinFile(w.id, { kind: 'path', label: 'p', relPath: 'a.txt' }, UI)
ok('content on a work project gives 403, a bare path is fine')

// --------------------------------------------------------------- runs ----

const hello = S.saveAutomation(a.id, 'hello', { kind: 'agent', name: 'hello', body: 'Say hi.', model: 'haiku' }, SESSION)
fails(403, () => S.createRun(a.id, 'hello', hello.rev, SESSION))
fails(404, () => S.createRun(a.id, 'nope', 1, TERM))
const run = S.createRun(a.id, 'hello', hello.rev, TERM)
assert.equal(run.status, 'starting')
const brief = S.takeRunBrief(a.id, run.id)
assert.match(brief.brief, /^# Valkyrie agent: hello\n/)
assert.ok(brief.brief.includes(`Run id: ${run.id}.`))
assert.ok(brief.brief.endsWith('say so in your last message.\n'))
assert.equal(brief.model, 'haiku')
assert.equal(brief.name, 'hello')
fails(410, () => S.takeRunBrief(a.id, run.id))
fails(404, () => S.takeRunBrief(w.id, run.id))
const reported = S.reportRun(a.id, run.id, 'done', 'ok', SESSION)
assert.equal(reported.status, 'done')
assert.ok(reported.endedAt)
const hello2 = S.saveAutomation(a.id, 'hello', { kind: 'agent', name: 'hello', body: 'Say hi twice.' }, SESSION)
assert.equal(hello2.rev, hello.rev + 1)
assert.equal(fails(409, () => S.createRun(a.id, 'hello', hello.rev, TERM))?.currentRev, hello2.rev)
const killedRun = S.createRun(a.id, 'hello', hello2.rev, TERM)
S.attachRun(killedRun.id, SID, TMUX)
S.failRunsForTmux(TMUX, 'stopped before it reported')
doc = await S.getProjectDoc(a.id)
assert.equal(doc.runs.find((r) => r.id === killedRun.id)?.status, 'failed')
assert.equal(doc.runs.find((r) => r.id === run.id)?.status, 'done')
ok('createRun (only on the rev that was shown), the brief once then 410, run_report, failRunsForTmux')

// ----------------------------------------------------------- sessions ----

const l1 = S.linkSession(a.id, { sessionId: SID, launchSessionId: SID, tmuxName: TMUX, mode: 'new', via: 'launch' }, TERM)
const l2 = S.linkSession(a.id, { sessionId: SID, launchSessionId: SID, via: 'startup' }, HOOK)
assert.equal(l1.created, true)
assert.equal(l2.created, false)
doc = await S.getProjectDoc(a.id)
const linked = doc.sessions.filter((s) => s.sessionId === SID)
assert.equal(linked.length, 1)
assert.equal(linked[0].tmuxName, TMUX)
assert.equal(S.setSessionStatus(a.id, SID, 'testing', SESSION), 1)
assert.equal((await S.getProjectDoc(a.id)).sessions[0].statusNote, 'testing')
ok('linkSession twice leaves one row')

// /clear in the launched process gives C2, linked under SID. Resumed from the
// page, C2's own process sends C2 as its launch id: its row must still answer.
const C2 = '22222222-3333-4444-5555-666666666666'
const C2_SESSION: Ctx = { actor: `session:${C2}`, via: 'mcp' }
S.linkSession(a.id, { sessionId: C2, launchSessionId: SID, via: 'clear' }, HOOK)
S.linkSession(a.id, { sessionId: C2, launchSessionId: C2, tmuxName: TMUX, mode: 'resume', via: 'resume' }, TERM)
assert.equal((await S.getProjectDoc(a.id)).sessions.find((s) => s.sessionId === C2)?.launchSessionId, SID)
assert.equal(S.setSessionStatus(a.id, C2, 'resumed', C2_SESSION), 1)
assert.equal(S.setSessionStatus(a.id, SID, 'whole group', SESSION), 2)
assert.deepEqual(S.projectsForSession(C2), [a.id])
// The run killedRun was attached to SID: its conversation, and the /clear
// made from it, both find it again after a resume.
assert.equal(S.runForSession(a.id, SID), killedRun.id)
assert.equal(S.runForSession(a.id, C2), killedRun.id)
assert.equal(S.runForSession(a.id, '33333333-4444-5555-6666-777777777777'), null)
ok('session_status and run lookup after a /clear and a page resume')

// ------------------------------------------------------- undo, revert ----

S.moveTab(a.id, todo.id, 0, UI)
const events = S.listEvents(a.id, { limit: 100 })
const undoable = (action: string) => events.find((e) => e.action === action)?.undoable
assert.equal(undoable('project.create'), false)
assert.equal(undoable('tab.add'), true)
assert.equal(undoable('tab.append'), true)
assert.equal(undoable('tab.item'), true)
assert.equal(undoable('file.pin'), true)
assert.equal(undoable('automation.save'), true)
assert.equal(undoable('tab.move'), false)
assert.equal(undoable('run.start'), false)
assert.equal(undoable('session.link'), false)
ok('undoable flags')

const before = S.getTab(a.id, notes.id)
S.updateTab(a.id, notes.id, { baseRev: before.rev, body: 'replaced' }, UI)
const [edit] = S.listEvents(a.id, { limit: 1 })
assert.equal(edit.action, 'tab.update')
assert.equal(edit.undoable, true)
fails(403, () => S.undoEvent(a.id, edit.id, { onlyActor: SESSION.actor }, SESSION))
S.undoEvent(a.id, edit.id, {}, UI)
assert.equal(S.getTab(a.id, notes.id).body, 'first\n\nsecond')
fails(409, () => S.undoEvent(a.id, edit.id, {}, UI))
const [undo] = S.listEvents(a.id, { limit: 1 })
assert.equal(undo.action, 'undo')
assert.equal(undo.undoOf, edit.id)
assert.equal(undo.undoable, false)
assert.equal(S.listEvents(a.id, { before: undo.id, limit: 1 })[0].undoneBy, undo.id)
ok('undoEvent on a tab.update restores the body')

const tail = S.addTab(a.id, { kind: 'markdown', title: 'tail' }, UI)
S.updateTab(a.id, tail.id, { appendBody: 'moved later' }, SESSION)
const [appendEv] = S.listEvents(a.id, { limit: 1 })
S.moveTab(a.id, tail.id, 0, UI)
S.undoEvent(a.id, appendEv.id, {}, UI)
assert.equal((await S.getProjectDoc(a.id)).tabs[0].id, tail.id)
ok('undoing an edit keeps a later move')

const c = S.createProject({ name: 'smoke revert', area: 'server', targetKey: 'vk-smoke' }, UI)
const cNotes = (await S.getProjectDoc(c.id)).tabs[0]
const scratch = S.addTab(c.id, { kind: 'markdown', title: 'scratch', body: 'a' }, SESSION)
const s2 = S.updateTab(c.id, scratch.id, { baseRev: scratch.rev, body: 'b' }, SESSION)
S.updateTab(c.id, scratch.id, { baseRev: s2.rev, body: 'c' }, SESSION)
S.updateProject(c.id, { nextAction: 'session step' }, SESSION)
const shared = S.addTab(c.id, { kind: 'markdown', title: 'shared' }, UI)
const sh1 = S.updateTab(c.id, shared.id, { baseRev: shared.rev, body: 'from the session' }, SESSION)
S.updateTab(c.id, shared.id, { baseRev: sh1.rev, body: 'from the page' }, UI)
const keep = S.addTab(c.id, { kind: 'markdown', title: 'keep' }, OTHER)
S.updateTab(c.id, cNotes.id, { baseRev: cNotes.rev, body: 'mine' }, UI)
assert.deepEqual(S.revertActor(c.id, SESSION.actor, UI), { reverted: 4, conflicts: 1 })
fails(404, () => S.getTab(c.id, scratch.id))
assert.equal(S.getProject(c.id)?.nextAction, '')
assert.equal(S.getTab(c.id, shared.id).body, 'from the page')
assert.equal(S.getTab(c.id, keep.id).title, 'keep')
assert.equal(S.getTab(c.id, cNotes.id).body, 'mine')
ok('revertActor undoes only that actor, and stops where someone else edited after it')

// ---------------------------------------------------------- long-poll ----

const base = S.currentChange(a.id)
let t0 = Date.now()
const woke = S.waitForChange(a.id, base.rev, 5_000)
setTimeout(() => S.addTab(a.id, { kind: 'markdown', title: 'later' }, UI), 50)
const changed = await woke
assert.ok(changed.rev > base.rev)
assert.ok(Date.now() - t0 < 1_000, `took ${Date.now() - t0} ms`)
assert.equal(changed.lastEvent?.action, 'tab.add')
t0 = Date.now()
const idle = await S.waitForChange(a.id, changed.rev, 300)
assert.equal(idle.rev, changed.rev)
assert.ok(Date.now() - t0 >= 250)
const ac = new AbortController()
t0 = Date.now()
const aborted = S.waitForChange(a.id, changed.rev, 10_000, ac.signal)
setTimeout(() => ac.abort(), 20)
await aborted
assert.ok(Date.now() - t0 < 1_000)
assert.equal((await S.waitForChange(a.id, changed.rev - 1, 10_000)).rev, changed.rev)
ok('waitForChange wakes on a change, times out and aborts cleanly')

// ------------------------------------------------------------ reminders ----

assert.equal(await addLilkupsReminder(daysFromNow(2).replace(/\.\d{3}Z$/, '+00:00'), 'proj-smoke-test', 'hello'), 'abcd1234')
const rem = await S.addReminder(a.id, { at: daysFromNow(2), message: 'smoke reminder' }, UI)
assert.equal(rem.state, 'pending')
assert.match(rem.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/)
assert.ok((await S.getProjectDoc(a.id)).reminders.some((r) => r.id === rem.id && r.state === 'pending'))
assert.equal(S.listProjects().find((p) => p.id === a.id)?.nextReminderAt, rem.at)
await failsAsync(400, () => S.addReminder(a.id, { at: '2026-10-07T09:00:00', message: 'naive' }, UI))
await failsAsync(400, () => S.addReminder(a.id, { at: new Date(Date.now() - 60_000).toISOString(), message: 'past' }, UI))
await failsAsync(400, () => S.addReminder(a.id, { at: daysFromNow(400), message: 'too far' }, UI))
await failsAsync(400, () => S.addReminder(a.id, { at: daysFromNow(2), message: '   ' }, UI))
await failsAsync(400, () => addLilkupsReminder(daysFromNow(2), 'proj-smoke-test', '-'))
await S.cancelReminder(a.id, rem.id, UI)
assert.equal((await S.getProjectDoc(a.id)).reminders.find((r) => r.id === rem.id)?.state, 'canceled')
ok('addReminder gets the fake id, cancelReminder works')

// ------------------------------------------------- switches and limits ----

S.updateProject(a.id, { sessionEdits: false }, UI)
fails(403, () => S.addTab(a.id, { kind: 'markdown', title: 'nope' }, SESSION))
S.updateProject(a.id, { sessionEdits: true }, UI)
fails(403, () => S.updateProject(a.id, { exposure: 'tailnet' }, SESSION))
{
  // A session may move a project between areas, and only ever tightens.
  const g = S.createProject({ name: 'smoke area', area: 'personal', targetKey: 'vk-smoke' }, SESSION)
  const moved = S.updateProject(g.id, { area: 'work', targetKey: 'vk-other' }, SESSION)
  assert.equal(moved.exposure, 'tailnet')
  assert.equal(moved.allowSnapshots, false)
  assert.equal(moved.targetKey, 'vk-other')
  const back = S.updateProject(g.id, { area: 'personal' }, SESSION)
  assert.equal(back.area, 'personal')
  assert.equal(back.exposure, 'tailnet')
}
S.updateProject(w.id, { exposure: 'anywhere' }, UI)
const [exposed] = S.listEvents(w.id, { limit: 1 })
assert.equal(exposed.undoable, true)
S.undoEvent(w.id, exposed.id, {}, UI)
assert.equal(S.getProject(w.id)?.exposure, 'tailnet')
ok('undoing a settings change restores the setting')

const m = S.createProject({ name: 'smoke moved', area: 'personal', targetKey: 'vk-smoke' }, UI)
const snap = S.pinFile(m.id, { kind: 'path', label: 'plan', relPath: 'plan.md', content: '# plan' }, UI)
const mdoc = S.pinFile(m.id, { kind: 'doc', label: 'doc', content: 'words' }, UI)
await S.addReminder(m.id, { at: daysFromNow(3), message: 'full text' }, UI)
S.updateProject(m.id, { area: 'work' }, UI)
assert.match(S.listEvents(m.id, { limit: 1 })[0].summary, /dropped 2 stored file contents$/)
const mfiles = (await S.getProjectDoc(m.id)).files
assert.ok(mfiles.every((f) => !f.hasContent))
assert.equal(mfiles.find((f) => f.id === mdoc.id)?.kind, 'doc')
fails(404, () => S.getFileContent(m.id, snap.id))
assert.equal(await S.reissueClientReminders(m.id), 0)
ok('moving into work drops stored contents and reissues reminders as pointers')

S.archiveProject(w.id, UI)
fails(404, () => S.addTab(w.id, { kind: 'markdown', title: 'nope' }, SESSION))
assert.ok(!S.listProjects().some((p) => p.id === w.id))
assert.ok(S.listProjects({ includeArchived: true }).some((p) => p.id === w.id))
assert.equal(S.updateProject(w.id, { status: 'active' }, UI).status, 'active')
ok('session edits switch, settings locked to the page, archive hides from sessions')

const d = S.createProject({ name: 'smoke limits', area: 'personal', targetKey: 'vk-smoke' }, UI)
const dNotes = (await S.getProjectDoc(d.id)).tabs[0]
for (let i = 0; i < 30; i++) S.updateTab(d.id, dNotes.id, { appendBody: `line ${i}` }, SESSION)
fails(429, () => S.updateTab(d.id, dNotes.id, { appendBody: 'one too many' }, SESSION))
S.updateTab(d.id, dNotes.id, { appendBody: 'the page is not limited' }, UI)
const e = S.createProject({ name: 'smoke notify', area: 'personal', targetKey: 'vk-smoke' }, UI)
for (let i = 0; i < 5; i++) S.noteNotify(e.id, SESSION, `note ${i}`)
fails(429, () => S.noteNotify(e.id, SESSION, 'one too many'))
assert.equal(S.listEvents(e.id, { limit: 1 })[0].undoable, false)
ok('session write and notify limits')

const f = S.createProject({ name: 'smoke autos', area: 'personal', targetKey: 'vk-smoke' }, UI)
const WRITER: Ctx = { actor: 'session:99999999-2222-3333-4444-555555555555', via: 'mcp' }
const v1 = S.saveAutomation(f.id, 'brief', { kind: 'agent', name: 'brief', body: 'v1', baseRev: 0 }, UI)
const v2 = S.saveAutomation(f.id, 'brief', { kind: 'agent', name: 'brief', body: 'v2' }, WRITER)
assert.equal((fails(409, () => S.saveAutomation(f.id, 'brief', { kind: 'agent', name: 'brief', body: 'mine', baseRev: v1.rev }, UI))?.current as { body?: string } | undefined)?.body, 'v2')
assert.equal((fails(409, () => S.saveAutomation(f.id, 'brief', { kind: 'agent', name: 'brief', body: 'new', baseRev: 0 }, UI))?.current as { rev?: number } | undefined)?.rev, v2.rev)
assert.equal(S.saveAutomation(f.id, 'brief', { kind: 'agent', name: 'brief', body: 'mine', baseRev: v2.rev }, UI).body, 'mine')
S.removeAutomation(f.id, 'brief', UI)
fails(409, () => S.saveAutomation(f.id, 'brief', { kind: 'agent', name: 'brief', body: 'x', baseRev: v2.rev + 1 }, UI))
ok('a page save with baseRev gets 409 and the current version after a session edit, a reused key or a removal')

console.log('projects smoke ok')
