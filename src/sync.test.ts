// Real git repositories in a temp folder; no mocks. Global git hooks are switched off for every
// call so a user's own post-checkout hook cannot copy files before the code under test runs.
import { execFileSync } from 'node:child_process'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync,
  statSync, symlinkSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { DEFAULT_MAX_MB, DEFAULT_PATHS, cleanPaths, syncKit } from './sync'

const MB = 1024 * 1024
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-sync-')))
let counter = 0
const run = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' })
const put = (base: string, rel: string, text = rel): void => {
  mkdirSync(join(base, rel, '..'), { recursive: true })
  writeFileSync(join(base, rel), text)
}
/** A repo whose only commit tracks `.claude/skills/t/SKILL.md` (force-added: a global gitignore may hide .claude). */
const makeRepo = (): string => {
  const repo = join(root, `repo${counter++}`)
  mkdirSync(repo)
  run(repo, 'init', '-q')
  run(repo, 'config', 'user.email', 't@t')
  run(repo, 'config', 'user.name', 't')
  put(repo, '.claude/skills/t/SKILL.md', 'COMMITTED')
  run(repo, 'add', '-f', '.claude/skills/t/SKILL.md')
  run(repo, 'commit', '-q', '-m', 'init')
  return repo
}
const addWorktree = (repo: string, noCheckout = true): string => {
  const wt = join(root, `wt${counter++}`)
  run(repo, 'worktree', 'add', '-q', '--detach', ...(noCheckout ? ['--no-checkout'] : []), wt, 'HEAD')
  return wt
}
const all = { paths: DEFAULT_PATHS, maxBytes: DEFAULT_MAX_MB * MB }

test('copies the untracked kit: bytes, symlinks, executable bits and odd file names survive', async () => {
  const repo = makeRepo()
  put(repo, 'AGENTS.md', 'agents')
  symlinkSync('AGENTS.md', join(repo, 'CLAUDE.md'))
  symlinkSync('CLAUDE.md', join(repo, 'GEMINI.md'))
  put(repo, '.mcp.json', '{"a":1}')
  put(repo, '.claude/settings.local.json', 'settings')
  put(repo, '.claude/hooks/run.sh', '#!/bin/sh\necho hi\n')
  chmodSync(join(repo, '.claude/hooks/run.sh'), 0o755)
  put(repo, '.claude/notes/my note \u00e9\u00e8.md', 'unicode and spaces')
  const wt = addWorktree(repo)
  const result = await syncKit(wt, all)
  assert.equal(result.status, 'copied')
  assert.equal(result.copied, 7)
  for (const rel of ['AGENTS.md', '.mcp.json', '.claude/settings.local.json', '.claude/hooks/run.sh', '.claude/notes/my note \u00e9\u00e8.md']) {
    assert.equal(readFileSync(join(wt, rel), 'utf8'), readFileSync(join(repo, rel), 'utf8'))
  }
  assert.equal(lstatSync(join(wt, 'CLAUDE.md')).isSymbolicLink(), true)
  assert.equal(readlinkSync(join(wt, 'CLAUDE.md')), 'AGENTS.md')
  assert.equal(readlinkSync(join(wt, 'GEMINI.md')), 'CLAUDE.md')
  assert.equal(statSync(join(wt, '.claude/hooks/run.sh')).mode & 0o777, 0o755)
})

test('tracked files are never touched, including a checkout that happens AFTER the sync', async () => {
  const repo = makeRepo()
  put(repo, 'AGENTS.md', 'agents')
  put(repo, '.claude/settings.local.json', 'settings')
  put(repo, '.claude/skills/t/SKILL.md', 'PRIMARY-DIRTY') // uncommitted edit to a tracked file: the collision bait
  const late = addWorktree(repo, true) // Orca-style: created with --no-checkout
  await syncKit(late, all)
  assert.equal(existsSync(join(late, '.claude/skills/t/SKILL.md')), false) // not pre-created
  run(late, 'checkout', '-q', '-f', 'HEAD') // would fail with "untracked files would be overwritten" if it had been
  assert.equal(readFileSync(join(late, '.claude/skills/t/SKILL.md'), 'utf8'), 'COMMITTED')
  assert.equal(readFileSync(join(late, 'AGENTS.md'), 'utf8'), 'agents')
  const normal = addWorktree(repo, false)
  put(normal, '.claude/skills/t/SKILL.md', 'WORKTREE-EDIT')
  await syncKit(normal, all)
  assert.equal(readFileSync(join(normal, '.claude/skills/t/SKILL.md'), 'utf8'), 'WORKTREE-EDIT')
})

test('never overwrites a file that already exists in the worktree', async () => {
  const repo = makeRepo()
  put(repo, 'AGENTS.md', 'from primary')
  put(repo, '.mcp.json', 'from primary')
  const wt = addWorktree(repo, false)
  put(wt, 'AGENTS.md', 'MINE')
  const result = await syncKit(wt, all)
  assert.equal(readFileSync(join(wt, 'AGENTS.md'), 'utf8'), 'MINE')
  assert.equal(readFileSync(join(wt, '.mcp.json'), 'utf8'), 'from primary')
  assert.equal(result.existing, 1)
  assert.equal(result.copied, 1)
  const again = await syncKit(wt, all) // a second run changes nothing
  assert.equal(again.copied, 0)
  assert.equal(again.status, 'nothing')
})

test('over the size limit it refuses everything, not just the big file', async () => {
  const repo = makeRepo()
  put(repo, 'AGENTS.md', 'small')
  mkdirSync(join(repo, '.run'))
  writeFileSync(join(repo, '.run/big.bin'), Buffer.alloc(60 * MB))
  const wt = addWorktree(repo)
  const refused = await syncKit(wt, { paths: DEFAULT_PATHS, maxBytes: 50 * MB })
  assert.equal(refused.status, 'refused')
  assert.equal(refused.copied, 0)
  assert.equal(existsSync(join(wt, 'AGENTS.md')), false)
  assert.equal(/60\.0 MB.*50\.0 MB/.test(refused.message ?? ''), true)
  const allowed = await syncKit(wt, { paths: DEFAULT_PATHS, maxBytes: 100 * MB })
  assert.equal(allowed.status, 'copied')
  assert.equal(existsSync(join(wt, '.run/big.bin')), true)
})

test('does nothing in the primary checkout itself, and does not throw outside a repository', async () => {
  const repo = makeRepo()
  put(repo, 'AGENTS.md', 'x')
  assert.equal((await syncKit(repo, all)).status, 'primary')
  const outside = join(root, 'not-a-repo')
  mkdirSync(outside)
  const result = await syncKit(outside, all)
  assert.equal(result.status, 'failed')
  assert.equal(typeof result.message, 'string')
})

test('skips worktrees/, node_modules/, backups, lock files, nested repos and git internals', async () => {
  const repo = makeRepo()
  put(repo, '.claude/ok.md', 'ok')
  put(repo, '.claude/worktrees/x/f', 'no')
  put(repo, '.claude/node_modules/m/i.js', 'no')
  put(repo, '.claude/settings.local.json.bak-1', 'no')
  put(repo, '.claude/scheduled.lock', 'no')
  put(repo, '.claude/.DS_Store', 'no')
  mkdirSync(join(repo, '.claude/nested'))
  run(join(repo, '.claude/nested'), 'init', '-q')
  put(repo, '.claude/nested/inside.md', 'no')
  const wt = addWorktree(repo)
  const result = await syncKit(wt, all)
  assert.equal(result.copied, 1)
  assert.equal(result.nested >= 1, true)
  for (const rel of ['worktrees', 'node_modules', 'settings.local.json.bak-1', 'scheduled.lock', '.DS_Store', 'nested']) {
    assert.equal(existsSync(join(wt, '.claude', rel)), false)
  }
})

test('copies only what is listed: the defaults leave .env alone, a custom list can add it', async () => {
  const repo = makeRepo()
  put(repo, '.env', 'SECRET=1')
  put(repo, 'AGENTS.md', 'a')
  assert.equal(DEFAULT_PATHS.includes('.env'), false)
  const first = addWorktree(repo)
  await syncKit(first, all)
  assert.equal(existsSync(join(first, '.env')), false)
  const second = addWorktree(repo)
  await syncKit(second, { paths: ['.env'], maxBytes: 5 * MB })
  assert.equal(existsSync(join(second, '.env')), true)
  assert.equal(existsSync(join(second, 'AGENTS.md')), false)
})

test('paths are literal: a glob character does not expand', async () => {
  const repo = makeRepo()
  put(repo, 'AGENTS.md', 'a')
  const wt = addWorktree(repo)
  const result = await syncKit(wt, { paths: ['*.md'], maxBytes: 5 * MB })
  assert.equal(result.status, 'nothing')
  assert.equal(existsSync(join(wt, 'AGENTS.md')), false)
})

test('cleanPaths keeps safe repo-relative paths and rejects everything that could escape', () => {
  const { paths, rejected } = cleanPaths([
    '../x', '/etc/passwd', ':(glob)*', '.git', '.git/config', 'C:\\x', 'a/../b',
    '', '   ', '# a comment', ' ./a/ ', 'a', 'ok\\b', '.claude'
  ])
  assert.deepEqual(paths, ['a', 'ok/b', '.claude'])
  assert.equal(rejected.length, 7)
})

test('the manifest defaults are exactly the code defaults', () => {
  const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
  const settings = Object.fromEntries(manifest.contributes.settings.map((s: { key: string; default: unknown }) => [s.key, s.default]))
  assert.equal(settings.paths, DEFAULT_PATHS.join('\n'))
  assert.equal(settings.maxMegabytes, DEFAULT_MAX_MB)
})
