// Core logic: copy the files a repo's primary checkout holds but git does not track (CLAUDE.md,
// .claude/, .mcp.json, .env, anything the user lists) into a new worktree of the same repo.
//
// Rules, in the order they matter:
//  - Only paths git reports as untracked or ignored in the primary are candidates. Tracked files
//    arrive through the checkout itself, so they can never collide with it.
//  - Never overwrite: a file that already exists in the worktree is left alone.
//  - Symlinks stay symlinks. File modes survive (a hook script stays executable).
//  - All or nothing on size: if the candidates exceed the limit, nothing is copied.
//  - Nested git repos, git internals and clutter (worktrees/, node_modules/, backups, lock files)
//    are never copied.
//  - Never throws for a normal problem; the caller gets a result to log.
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readlink, realpath, symlink } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'

export const DEFAULT_PATHS: readonly string[] = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.mcp.json',
  '.cursorrules',
  '.cursorignore',
  '.cursor/mcp.json',
  '.claude',
  '.run',
  '.ai',
  '.codex',
  '.augment'
]
export const DEFAULT_MAX_MB = 50

export type SyncOptions = { paths: readonly string[]; maxBytes: number }
export type SyncResult = {
  status: 'copied' | 'nothing' | 'primary' | 'refused' | 'failed'
  /** Files and symlinks newly created in the worktree. */
  copied: number
  /** Candidates that already existed in the worktree and were left alone. */
  existing: number
  /** Candidates that could not be copied (permissions, a file where a folder was needed...). */
  failed: number
  /** Nested git repositories that were skipped. */
  nested: number
  /** Total size of the candidates. */
  bytes: number
  primary?: string
  /** The reason, for `refused` and `failed`. */
  message?: string
}

const SKIP = /(^|\/)(worktrees|node_modules)\/|\.bak-|\.lock$|\.DS_Store$/
const POSIX_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin'

const emptyResult = (status: SyncResult['status'], extra: Partial<SyncResult> = {}): SyncResult => ({
  status, copied: 0, existing: 0, failed: 0, nested: 0, bytes: 0, ...extra
})

function git(cwd: string, args: string[]): Promise<string> {
  const env = process.platform === 'win32' ? process.env : { ...process.env, PATH: `${POSIX_PATH}:${process.env.PATH ?? ''}` }
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--literal-pathspecs', ...args],
      { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })
}

/** Turns the user's list into safe, literal, repo-relative paths. Blank lines and `#` comments are
 *  ignored; anything that could leave the repo or reach git internals is rejected. */
export function cleanPaths(raw: readonly string[]): { paths: string[]; rejected: string[] } {
  const paths: string[] = []
  const rejected: string[] = []
  for (const line of raw) {
    let path = line.trim().replace(/\\/g, '/')
    if (!path || path.startsWith('#')) continue
    path = path.replace(/^(\.\/)+/, '').replace(/\/+$/, '')
    const unsafe =
      !path ||
      path.startsWith('/') ||
      /^[A-Za-z]:/.test(path) ||
      path.startsWith(':') ||
      path.includes('\0') ||
      path.split('/').some((part) => part === '..' || part === '.') ||
      path === '.git' ||
      path.startsWith('.git/')
    if (unsafe) rejected.push(line.trim())
    else if (!paths.includes(path)) paths.push(path)
  }
  return { paths, rejected }
}

export async function syncKit(worktree: string, options: SyncOptions): Promise<SyncResult> {
  try {
    const { paths } = cleanPaths(options.paths)
    if (paths.length === 0) return emptyResult('nothing')

    const top = await realpath((await git(worktree, ['rev-parse', '--show-toplevel'])).trim())
    const firstWorktree = /^worktree (.+)$/m.exec(await git(top, ['worktree', 'list', '--porcelain']))?.[1]
    const primary = firstWorktree ? await realpath(firstWorktree) : undefined
    if (!primary || primary === top) return emptyResult('primary')

    // -o without --exclude-standard lists untracked AND ignored files; -z keeps odd names intact.
    const listed = (await git(primary, ['ls-files', '-o', '-z', '--', ...paths])).split('\0').filter(Boolean)
    const nested = listed.filter((entry) => entry.endsWith('/')).length
    const files = listed.filter((entry) => !entry.endsWith('/') && !SKIP.test(entry))
    if (files.length === 0) return emptyResult('nothing', { primary, nested })

    let bytes = 0
    for (let i = 0; i < files.length; i += 64) {
      const sizes = await Promise.all(
        files.slice(i, i + 64).map((entry) => lstat(join(primary, ...entry.split('/'))).then((s) => s.size, () => 0))
      )
      for (const size of sizes) bytes += size
    }
    if (bytes > options.maxBytes) {
      return emptyResult('refused', {
        primary, nested, bytes,
        message: `the files to copy from ${primary} add up to ${(bytes / 1048576).toFixed(1)} MB, over the ${(options.maxBytes / 1048576).toFixed(1)} MB limit`
      })
    }

    let copied = 0
    let existing = 0
    let failed = 0
    let firstError: string | undefined
    for (const entry of files) {
      const parts = entry.split('/')
      const source = join(primary, ...parts)
      const target = join(top, ...parts)
      if (!target.startsWith(top + sep)) continue
      try {
        await mkdir(dirname(target), { recursive: true })
        if ((await lstat(source)).isSymbolicLink()) await symlink(await readlink(source), target)
        else await copyFile(source, target, constants.COPYFILE_EXCL)
        copied += 1
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') existing += 1
        else {
          failed += 1
          firstError ??= `${entry}: ${(error as Error).message}`
        }
      }
    }
    return {
      status: copied > 0 ? 'copied' : failed > 0 ? 'failed' : 'nothing',
      copied, existing, failed, nested, bytes, primary,
      ...(firstError ? { message: firstError } : {})
    }
  } catch (error) {
    return emptyResult('failed', { message: (error as Error).message })
  }
}
