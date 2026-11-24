import type { Phase } from '../types'

// Later in the list wins within one model step; a step with no signal keeps the current phase.
export const PHASES: Phase[] = ['Planning', 'Implementation', 'Validation', 'PR']

const SKILLS: [RegExp, Phase][] = [
  [/finishing|receiving|commit|\bpr\b/, 'PR'],
  [/verif|review|simplify|security|audit/, 'Validation'],
  [/implement|test-driven|executing|subagent-driven|new-repo|debugging|worktree/, 'Implementation'],
  [/brainstorm|plan|harness|slice|ledger|workspace|explain/, 'Planning'],
]

export function classify(name: string, input: unknown): Phase | null {
  const i = (input ?? {}) as { skill?: string; command?: string }
  if (name === 'Skill') return SKILLS.find(([re]) => re.test(i.skill ?? ''))?.[1] ?? null
  if (/^(Enter|Exit)PlanMode$|^AskUserQuestion$/.test(name)) return 'Planning'
  if (/^(Edit|Write|NotebookEdit)$/.test(name)) return 'Implementation'
  if (name.startsWith('mcp__ccd_pr__')) return 'PR'
  if (name === 'Bash') {
    const c = i.command ?? ''
    if (/\bgh (pr|api)\b|git (push|commit)/.test(c)) return 'PR'
    if (/\b(test|pytest|jest|vitest|tsc|lint|build|mvn|gradle|validate|check)\b/.test(c)) return 'Validation'
  }
  return null
}

export function stepPhase(uses: readonly { name: string; input: unknown }[], current: Phase): Phase {
  const hits = uses.map(u => classify(u.name, u.input)).filter((p): p is Phase => !!p)
  return hits.length ? hits.sort((a, b) => PHASES.indexOf(b) - PHASES.indexOf(a))[0] : current
}

// Finer row label: Bash by its command word, Skill by its skill name; everything else by tool name.
export function label(name: string, input: unknown): string {
  const i = (input ?? {}) as { skill?: string; command?: string }
  if (name === 'Skill' && i.skill) return `Skill:${i.skill}`
  if (name === 'Bash') {
    const w = (i.command ?? '').trim().split(/\s+/).find(t => !/^(cd|export|\w+=.*)$/.test(t) && t !== '&&' && !t.startsWith('/'))
    if (w) return `Bash:${w.slice(0, 20)}`
  }
  return name
}
