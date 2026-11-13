// Runs the kit sync (see sync.ts) at the right moments:
//  - workspace.created (an event) and workspace.create.after (a hook, observe-only): the kit lands
//    in every new worktree, even when no agent is started in it. Both are subscribed on purpose:
//    if Orca changes one, the other keeps working. Runs overlap harmlessly (the copy never
//    overwrites, and a run still in flight is shared).
//  - agent.launch.before (a hook, awaited): the kit exists BEFORE the agent CLI starts and reads
//    CLAUDE.md or .mcp.json, whichever launcher started it. Orca counts a hook running past 2 s as
//    passed, so this waits at most WAIT_MS.
//
// This worker never denies or changes anything. A missing git, a slow repo, a bad setting: every
// failure is logged and the worktree or agent launch carries on.
import type { OrcaWorkerApi } from 'orca/worker'
import { DEFAULT_MAX_MB, DEFAULT_PATHS, syncKit, type SyncResult } from './sync'

const WAIT_MS = 1700

export type SyncFn = typeof syncKit

export function createActivate(sync: SyncFn = syncKit) {
  return function activate(orca: OrcaWorkerApi): void {
    const running = new Map<string, Promise<void>>() // worktree path -> its IN-FLIGHT run only
    const pathById = new Map<string, string>() // workspace id -> worktree path

    async function readConfig(): Promise<{ paths: string[]; maxBytes: number }> {
      let paths = DEFAULT_PATHS.join('\n')
      let megabytes = DEFAULT_MAX_MB
      try {
        const settings = await orca.settings.get()
        if (typeof settings.paths === 'string') paths = settings.paths
        if (typeof settings.maxMegabytes === 'number' && settings.maxMegabytes >= 1) megabytes = settings.maxMegabytes
      } catch (error) {
        orca.log(`could not read settings, using the defaults: ${(error as Error).message}`)
      }
      return { paths: paths.split('\n'), maxBytes: megabytes * 1024 * 1024 }
    }

    function report(path: string, result: SyncResult): void {
      if (result.status === 'copied') {
        orca.log(`${path}: copied ${result.copied} file(s) (${Math.ceil(result.bytes / 1024)} KB) from ${result.primary}`)
      }
      if (result.status === 'refused' || result.status === 'failed' || result.failed > 0) {
        orca.log(`${path}: kit sync problem: ${result.message ?? 'see above'}`)
      }
    }

    // Both triggers share one run while it is still going. A finished run is forgotten at once:
    // it is idempotent and takes ~0.1 s, and a worktree re-created at the same path (Orca reuses
    // ~/orca/workspaces/<repo>/<name>) must be synced again.
    function run(path: string): Promise<void> {
      const inFlight = running.get(path)
      if (inFlight) return inFlight
      const job: Promise<void> = (async () => {
        try {
          report(path, await sync(path, await readConfig()))
        } catch (error) {
          orca.log(`${path}: kit sync failed: ${(error as Error).message}`)
        } finally {
          if (running.get(path) === job) running.delete(path)
        }
      })()
      running.set(path, job)
      return job
    }

    async function locate(workspaceId: string): Promise<string | undefined> {
      const known = pathById.get(workspaceId)
      if (known) return known
      try {
        const { workspaces } = await orca.host.call('workspace.list')
        for (const workspace of workspaces) {
          if (workspace.kind === 'worktree') pathById.set(workspace.id, workspace.path)
        }
      } catch (error) {
        orca.log(`workspace.list failed: ${(error as Error).message}`)
      }
      return pathById.get(workspaceId)
    }

    orca.events.on('workspace.created', (event) => {
      if (event.kind !== 'worktree') return
      pathById.set(event.workspaceId, event.path)
      void run(event.path)
    })

    orca.hooks.on('workspace.create.after', (event) => {
      if (event.kind !== 'worktree') return undefined
      pathById.set(event.workspaceId, event.path)
      void run(event.path)
      return undefined
    })

    orca.hooks.on('agent.launch.before', async (event) => {
      if (event.workspaceKind !== 'worktree' || !event.workspaceId) return undefined
      // The whole job, workspace lookup included, races ONE timer that starts at hook entry.
      const work = locate(event.workspaceId)
        .then((path) => (path ? run(path) : undefined))
        .catch(() => undefined)
      let timer: ReturnType<typeof setTimeout> | undefined
      const budget = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          orca.log(`kit sync still running after ${WAIT_MS} ms; the agent starts without waiting`)
          resolve()
        }, WAIT_MS)
      })
      await Promise.race([work, budget])
      if (timer) clearTimeout(timer)
      return undefined
    })
  }
}

export default createActivate()
