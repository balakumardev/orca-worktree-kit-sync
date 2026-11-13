// Runs the hooks and the event as Orca would, with this worker as the only plugin in the chain.
// Most tests inject a fake sync so timing and wiring are exact; the last one uses the real sync.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import * as realWorker from './worker'
import { createActivate } from './worker'
import type { SyncOptions, SyncResult } from './sync'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const created = (workspaceId: string, path: string, kind: 'worktree' | 'folder' = 'worktree') => ({
  workspaceId, kind, path, branch: 'b'
})
const launch = (workspaceId: string | null, kind: 'worktree' | 'folder' | null = 'worktree') => ({
  agent: 'claude', workspaceId, workspaceKind: kind, command: 'claude', env: {}
})
const ok: SyncResult = { status: 'copied', copied: 1, existing: 0, failed: 0, nested: 0, bytes: 2048, primary: '/primary' }

/** A fake sync that records calls, can take time, and can throw. */
const fake = (delayMs = 0, fails = false) => {
  const calls: { path: string; options: SyncOptions }[] = []
  let finished = 0
  const fn = async (path: string, options: SyncOptions): Promise<SyncResult> => {
    calls.push({ path, options })
    if (delayMs) await sleep(delayMs)
    if (fails) throw new Error('boom')
    finished += 1
    return ok
  }
  return { fn, calls, finished: () => finished }
}
const mount = (f: ReturnType<typeof fake>, host?: ReturnType<typeof mockHost>) =>
  mountWorker({ default: createActivate(f.fn) }, host ? { host } : undefined)

test('workspace.create.after syncs a new worktree with the default settings, and skips folders', async () => {
  const f = fake()
  const worker = await mount(f)
  await worker.hooks.fire('workspace.create.after', created('w1', '/wt/one'))
  await worker.hooks.fire('workspace.create.after', created('f1', '/folder', 'folder'))
  await sleep(50)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].path, '/wt/one')
  assert.equal(f.calls[0].options.paths.includes('CLAUDE.md'), true)
  assert.equal(f.calls[0].options.paths.includes('.claude'), true)
  assert.equal(f.calls[0].options.maxBytes, 50 * 1024 * 1024)
  assert.equal(worker.logs.some((line) => line.includes('copied 1 file(s)')), true)
  await worker.deactivate()
})

test('the workspace.created event is a second, independent trigger', async () => {
  const f = fake()
  const worker = await mount(f)
  await worker.emit('workspace.created', created('w2', '/wt/two'))
  await sleep(50)
  assert.deepEqual(f.calls.map((c) => c.path), ['/wt/two'])
  await worker.deactivate()
})

test('the event and the hook for the same worktree share one run while it is in flight', async () => {
  const f = fake(300)
  const worker = await mount(f)
  await worker.hooks.fire('workspace.create.after', created('w3', '/wt/three'))
  await worker.emit('workspace.created', created('w3', '/wt/three'))
  await sleep(500)
  assert.equal(f.calls.length, 1)
  await worker.deactivate()
})

test('agent.launch.before waits for the copy to finish before the agent starts', async () => {
  const f = fake(800)
  const worker = await mount(f)
  await worker.hooks.fire('workspace.create.after', created('w4', '/wt/four'))
  const decision = await worker.hooks.fire('agent.launch.before', launch('w4'))
  assert.equal(decision.kind, 'continue')
  assert.equal(f.finished(), 1) // the hook returned only after the sync finished
  assert.equal(f.calls.length, 1) // one run shared by both triggers
  await worker.deactivate()
})

test('agent.launch.before finds a worktree it never saw created, via workspace.list', async () => {
  const f = fake()
  const worker = await mount(f)
  worker.host.respond('workspace.list', {
    workspaces: [{ id: 'w5', kind: 'worktree', name: 'x', path: '/wt/five', branch: 'b', hostId: null }],
    truncated: false
  })
  await worker.hooks.fire('agent.launch.before', launch('w5'))
  assert.deepEqual(f.calls.map((c) => c.path), ['/wt/five'])
  await worker.deactivate()
})

test('folders, unknown workspaces and no workspace pass without syncing anything', async () => {
  const f = fake()
  const worker = await mount(f)
  worker.host.respond('workspace.list', { workspaces: [], truncated: false })
  for (const event of [launch('w6', 'folder'), launch(null, null), launch('nope')]) {
    assert.equal((await worker.hooks.fire('agent.launch.before', event)).kind, 'continue')
  }
  assert.equal(f.calls.length, 0)
  await worker.deactivate()
})

test('a hung sync never holds the agent past the hook budget', async () => {
  const f = fake(3500)
  const worker = await mount(f)
  await worker.hooks.fire('workspace.create.after', created('w7', '/wt/seven'))
  const started = Date.now()
  const decision = await worker.hooks.fire('agent.launch.before', launch('w7'))
  assert.equal(decision.kind, 'continue')
  assert.equal(Date.now() - started < 1950, true)
  assert.equal(worker.logs.some((line) => line.includes('still running after 1700 ms')), true)
  await sleep(2000) // let the fake finish so nothing outlives the test
  await worker.deactivate()
})

test('a slow workspace.list counts against the same budget as the sync', async () => {
  const f = fake()
  const host = mockHost({
    results: {
      'workspace.list': async () => {
        await sleep(2300)
        return { workspaces: [{ id: 'w8', kind: 'worktree', name: 'x', path: '/wt/eight', branch: 'b', hostId: null }], truncated: false }
      }
    }
  })
  const worker = await mount(f, host)
  const decision = await worker.hooks.fire('agent.launch.before', launch('w8'))
  assert.equal(decision.kind, 'continue')
  // The harness's fire() also waits for the pending workspace.list mock call, so its wall time proves
  // nothing; the worker's own log does. A timer started only AFTER the list returned would never log this.
  assert.equal(worker.logs.some((line) => line.includes('still running after 1700 ms')), true)
  await sleep(300)
  assert.deepEqual(f.calls.map((c) => c.path), ['/wt/eight']) // and the work still happens in the background
  await worker.deactivate()
})

test('a worktree re-created at the same path is synced again', async () => {
  const f = fake()
  const worker = await mount(f)
  await worker.hooks.fire('workspace.create.after', created('w9', '/wt/nine'))
  await sleep(100)
  await worker.hooks.fire('workspace.create.after', created('w9', '/wt/nine')) // removed, then created again
  await sleep(100)
  await worker.hooks.fire('agent.launch.before', launch('w9')) // and an agent launch re-checks too
  assert.equal(f.calls.length, 3)
  await worker.deactivate()
})

test('a throwing sync is logged and passes; it never blocks or denies', async () => {
  const f = fake(0, true)
  const worker = await mount(f)
  await worker.hooks.fire('workspace.create.after', created('w10', '/wt/ten'))
  assert.equal((await worker.hooks.fire('agent.launch.before', launch('w10'))).kind, 'continue')
  assert.equal(worker.logs.some((line) => line.includes('kit sync failed: boom')), true)
  await worker.deactivate()
})

test('settings reach the sync; unreadable settings fall back to the defaults', async () => {
  const custom = fake()
  const a = await mount(custom, mockHost({ settings: { paths: 'one\ntwo', maxMegabytes: 7 } }))
  await a.hooks.fire('workspace.create.after', created('w11', '/wt/eleven'))
  await sleep(50)
  assert.deepEqual(custom.calls[0].options.paths, ['one', 'two'])
  assert.equal(custom.calls[0].options.maxBytes, 7 * 1024 * 1024)
  await a.deactivate()

  const broken = fake()
  const b = await mount(broken, mockHost({ results: { 'settings.get': () => { throw hostError('unavailable', 'down') } } }))
  await b.hooks.fire('workspace.create.after', created('w12', '/wt/twelve'))
  await sleep(50)
  assert.equal(broken.calls[0].options.paths.includes('CLAUDE.md'), true)
  assert.equal(broken.calls[0].options.maxBytes, 50 * 1024 * 1024)
  assert.equal(b.logs.some((line) => line.includes('could not read settings')), true)
  await b.deactivate()
})

test('end to end with the REAL sync: a no-checkout worktree of a scratch repo gets the kit before the agent starts', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-e2e-')))
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: 'pipe' })
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'i')
  writeFileSync(join(repo, 'AGENTS.md'), 'agents\n')
  writeFileSync(join(repo, '.mcp.json'), '{}\n')
  const wt = join(root, 'wt')
  git(repo, 'worktree', 'add', '-q', '--detach', '--no-checkout', wt, 'HEAD')
  const worker = await mountWorker(realWorker)
  await worker.hooks.fire('workspace.create.after', created('e1', wt))
  await worker.hooks.fire('agent.launch.before', launch('e1'))
  assert.equal(existsSync(join(wt, 'AGENTS.md')), true)
  assert.equal(existsSync(join(wt, '.mcp.json')), true)
  await worker.deactivate()
})
