export type Phase = 'Planning' | 'Implementation' | 'Validation' | 'PR'
export type ToolRow = { n: number; usd: number }
export type Ledger = Record<Phase, Record<string, ToolRow>>
// Same shape, keyed by model id: n = model steps, usd = their cost.
export type Models = Record<Phase, Record<string, ToolRow>>

declare module 'claude-code' {
  interface PluginState {
    'phase-cost': { ledger: Ledger; models: Models; phase: Phase; lastUsd: number | null; loaded: string | null }
  }
}
