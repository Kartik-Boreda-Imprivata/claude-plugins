# AGENTS.md

Monorepo of Claude Code mods. See [README.md](README.md) for what each does and how to install, update and remove it.

## Layout

```
.claude-plugin/marketplace.json   marketplace "kartik-mods"; one entry per mod, relative `source`
<mod>/.claude-plugin/plugin.json  manifest (name, version, "types")
<mod>/hooks/hooks.json            { "modules": ["./register.*"] }
<mod>/hooks/register.*            the mod: `export const register = on => { ... }`
<mod>/types/index.d.ts            the mod's own types
```

- `phase-cost`: TypeScript/TSX. `hooks/classify.ts` (phase rules) + `hooks/register.tsx` (state, `turn.step` accounting, `Pane` render). Has a `tsconfig.json`.
- `usage-band`: plain JavaScript. `hooks/register.js`; `scripts/tokens.mjs` (transcript token sum, run via `$.process.run`); `scripts/preview.mjs` (dev-only static HTML preview, not shipped behaviour); `tests/usage-band.test.ts`.

## Commands

```bash
claude plugin validate .            # marketplace; also run per mod folder
claude plugin test ./usage-band     # must pass before committing usage-band changes
claude --plugin-dir ./<mod>         # try a mod; saving a file hot-reloads it
```

`phase-cost` has no tests; validate it and load it with `--plugin-dir` to check a change.

## Rules

- Mods import only from `claude-code` (runtime import is empty; it is types plus `atom`/`read`/`update`). No npm dependencies, no build step.
- State goes in `atom({ plugin, key }, default)` read/updated with `read`/`update`, not module globals (the one exception today is the `refreshing` guard in `usage-band`).
- Never let a hook throw into the session: wrap I/O in `try/catch` and fall back, as the existing code does.
- Colours are mid-tone hex that reads on light and dark backgrounds. Render with `$.ui.resolve(e)`; no fixed-width character padding.
- `usage-band/scripts/preview.mjs` duplicates `pillSvg` from `register.js` by hand. If you change one, say so in the change; do not let them drift silently.
- Prices in `usage-band` (`basePrice`, `rewriteCost`, `readCost`) are hard-coded list prices with a date comment. Update the comment when you update the numbers.
- Adding a mod: new folder with the layout above, an entry in `.claude-plugin/marketplace.json`, a row in the README table, and `claude plugin validate` passing.
- Releasing a change: bump `version` in the mod's `plugin.json`, otherwise `claude plugin update` sees nothing new.

## Not here

- No CI, no lockfile. The GitHub home is `Kartik-Boreda-Imprivata/claude-plugins`; `.claude-plugin/marketplace.json` must be pushed there for installs to work.
- Do not commit `.claude/` or `.claude-plugin/types/` (engine-generated).
