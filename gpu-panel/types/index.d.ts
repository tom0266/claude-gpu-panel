export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Agents = { running: number; done: number; failed: number; models: string }

export type Gpu = { index: number; util: number; memGb: number }

export type GpuDetail = { index: number; util: number; memGb: number; totalGb: number; temp: number; users: string }

export type Job = { pid: string; elapsed: string; command: string }

export type Detail = { gpus: GpuDetail[]; jobs: Job[] }

declare module 'claude-code' {
  interface PluginState {
    'gpu-panel': {
      limits: Limit[]
      contextPercent: number | null
      agents: Agents
      model: string
      effort: string
      gpus: Gpu[] | null
      versions: Record<string, string>
      jobs: number
      detail: Detail
      sessionName: string
      warned: string[]
    }
  }
}
