export type Phase = 'Planning' | 'Implementation' | 'Validation' | 'PR'
export type ToolRow = { n: number; usd: number }
export type Ledger = Record<Phase, Record<string, ToolRow>>

declare module 'claude-code' {
  interface PluginState {
    'phase-cost': { ledger: Ledger; phase: Phase; lastUsd: number | null }
  }
}
