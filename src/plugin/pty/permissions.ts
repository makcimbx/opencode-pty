import type { PluginClient } from '../types.ts'
import { allStructured } from './wildcard.ts'
import { currentRuntime } from './runtime.ts'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

type PermissionAction = 'allow' | 'ask' | 'deny'
type BashPermissions = PermissionAction | Record<string, PermissionAction>
interface PermissionConfig {
  bash?: BashPermissions
  external_directory?: PermissionAction
}

export interface PermissionChecks {
  command(command: string, args: string[]): Promise<void>
  workdir(workdir: string): Promise<void>
}

let checks: PermissionChecks | undefined
let directory: string | undefined

// Standalone/V1 consumer compatibility; plugin instances use runtime-local checks.
export function initPermissionChecks(value: PermissionChecks): void {
  checks = value
  directory = undefined
}

export function initPermissions(client: PluginClient, value: string): void {
  checks = createLegacyPermissionChecks(client, value)
  directory = value
}

export function createLegacyPermissionChecks(
  client: PluginClient,
  project: string
): PermissionChecks {
  const config = async (): Promise<PermissionConfig> => {
    const response = await client.config.get()
    if (response.error || !response.data)
      throw new Error('PTY permission configuration is unavailable')
    return (response.data as { permission?: PermissionConfig }).permission ?? {}
  }
  const deny = async (message: string): Promise<never> => {
    try {
      await client.tui.showToast({ body: { message, variant: 'error' } })
    } catch {
      // A missing TUI must not turn a denial into an allowance.
    }
    throw new Error(message)
  }
  return {
    async command(command, args) {
      const permission = (await config()).bash
      const action =
        typeof permission === 'string'
          ? permission
          : permission
            ? allStructured({ head: command, tail: args }, permission)
            : 'allow'
      if (action === 'deny') {
        await deny(
          typeof permission === 'string'
            ? 'PTY spawn denied: All bash commands are disabled by user configuration.'
            : `PTY spawn denied: Command "${command} ${args.join(' ')}" is explicitly denied by user configuration.`
        )
      }
      if (action === 'ask') {
        await deny(
          `PTY spawn denied: Command "${command} ${args.join(' ')}" requires user permission (treated as denied). Configure explicit allow or deny rules.`
        )
      }
    },
    async workdir(workdir) {
      const projectDirectory = currentRuntime()?.directory ?? project
      if (await isProjectDirectory(projectDirectory, workdir)) return
      const action = (await config()).external_directory
      if (action === 'deny' || action === 'ask') {
        await deny(
          `PTY spawn denied: Working directory "${workdir}" is outside project directory "${projectDirectory}". External directory access ${action === 'ask' ? 'requires user permission (treated as denied)' : 'is denied by user configuration'}.`
        )
      }
    },
  }
}

export async function checkCommandPermission(command: string, args: string[]): Promise<void> {
  await (currentRuntime()?.permissions ?? checks)?.command(command, args)
}

export async function checkWorkdirPermission(workdir: string): Promise<void> {
  await (currentRuntime()?.permissions ?? checks)?.workdir(workdir)
}

export async function isProjectDirectory(project: string, workdir: string): Promise<boolean> {
  const [root, target] = await Promise.all([realpath(project), realpath(resolve(project, workdir))])
  const subpath = relative(root, target)
  return subpath !== '..' && !subpath.startsWith(`..${sep}`) && !isAbsolute(subpath)
}

export function defaultWorkdir(workdir?: string): string {
  return resolve(currentRuntime()?.directory ?? directory ?? process.cwd(), workdir ?? '.')
}
