declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      shut: boolean
      usage: {
        fiveHour: { percentUsed: number; resetsAt: string } | null
        sevenDay: { percentUsed: number; resetsAt: string } | null
        costUsd: number | null
        context: { tokens: number; window: number; percent: number } | null
        model: string | null
        tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; approx: boolean } | null
      } | null
      fallbackTokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
      lastResponseAt: number | null
      ttl: '5m' | '1h'
      handoff: { savedAt: number; path: string; summary: string; next: string[]; dismissed: boolean } | null
      handoffBusy: boolean
    }
  }
}
