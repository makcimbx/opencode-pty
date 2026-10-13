import { AsyncLocalStorage } from 'node:async_hooks'
import type { PTYManager } from './manager.ts'
import type { PermissionChecks } from './permissions.ts'

/** Services belong to one plugin instance; invocation identity belongs to one tool call. */
export interface PTYRuntime {
  manager: PTYManager
  permissions: PermissionChecks
  directory: string
  sessionID?: string
  agent?: string
  signal?: AbortSignal
}

export const ptyRuntime = new AsyncLocalStorage<PTYRuntime>()

export function currentRuntime(): PTYRuntime | undefined {
  return ptyRuntime.getStore()
}
