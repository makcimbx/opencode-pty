import type { Plugin } from '@opencode-ai/plugin'

export type PluginClient = Parameters<Plugin>[0]['client']

export type PluginContext = Parameters<Plugin>[0]

export type PluginResult = Awaited<ReturnType<Plugin>>

// The PTY lifecycle only needs these operations, independently of the host API version.
export interface SessionClient {
  session: {
    get(input: { path: { id: string } }): Promise<{
      data?: {
        parentID?: string
        model?: { id: string; providerID: string; variant?: string }
      }
    }>
    promptAsync(input: {
      path: { id: string }
      body: {
        messageID?: string
        parts: Array<{ type: 'text'; text: string }>
        agent?: string
        model?: { providerID: string; modelID: string }
        variant?: string
      }
    }): Promise<unknown>
  }
}
