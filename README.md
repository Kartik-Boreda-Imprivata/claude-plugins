# claude-plugins

Claude Code mods (plugins made of a hooks module) that put session cost and usage information in the UI.

| Mod | What it does |
|---|---|
| [`phase-cost`](phase-cost) | A pane showing session cost and tool calls per work phase (Planning, Implementation, Validation, PR) and per tool. Command: `/phase-cost`. |
| [`usage-band`](usage-band) | A band above the prompt: prompt-cache countdown and rewrite cost, 5h/7d limits, tokens and session cost. Commands: `/kb`, `/handoff`. |

Both are listed in one marketplace, [`kartik-mods`](.claude-plugin/marketplace.json), so the install, update and remove steps are the same for each. Replace `<mod>` with `phase-cost` or `usage-band`.

## Install

The `kartik-mods` marketplace only shows up after you add it; installing is two steps. Add the marketplace once:

```bash
claude plugin marketplace add Kartik-Boreda-Imprivata/claude-plugins
```

Then install a mod (`-s user` loads it in every session):

```bash
claude plugin install <mod>@kartik-mods -s user
```

Or in one line from the prompt of a terminal session (answer `y` to add the marketplace, then pick a scope):

```
/plugin install <mod> --marketplace Kartik-Boreda-Imprivata/claude-plugins
```

In the desktop app, `/plugin` does not run; click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `Kartik-Boreda-Imprivata/claude-plugins`, then **Add plugin**.

If the repository is private, you need read access on GitHub and a git credential on your machine (an SSH key, or `gh auth login` then `gh auth setup-git`); the install never prompts for one.

Check with `claude plugin marketplace list` and `claude plugin list`.

## Update

Bump `version` in the mod's `.claude-plugin/plugin.json`, push, then:

```bash
claude plugin marketplace update kartik-mods
claude plugin update <mod>@kartik-mods
```

Restart the session to apply.

## Remove

```bash
claude plugin uninstall <mod>@kartik-mods
```

To drop both mods and the marketplace entry: `claude plugin marketplace remove kartik-mods`.

Leftovers `uninstall` does not delete:

- `usage-band`: token cache in `~/.claude/plugins/store/usage-band/cache/`, `HANDOFF.md` in each project where `/handoff` ran, and archive copies in `~/.claude/handoffs/`.
- `phase-cost`: none (state lives in the session).

---

## phase-cost

Opens a "Cost by phase" pane at session start (reopen with `/phase-cost`). Each model step's cost is attributed to the phase its tool calls signal, using skill names, Plan mode, edit/write tools, `gh`/`git push`/test/build commands. A step with no signal stays in the current phase. Cost is read from `$.session.usage()`, so the total reconciles with `/cost`.

Phase rules live in [`phase-cost/hooks/classify.ts`](phase-cost/hooks/classify.ts).

## usage-band

| Command | Effect |
|---|---|
| `/kb` | Refresh and print a one-line summary (cache, context, limits, cost). |
| `/kb shut` / `/kb shine` | Hide / show the band. |
| `/kb ttl 5m\|1h` | Set the prompt-cache lifetime the countdown assumes. |
| `/handoff` | Summarise the session and next steps into `HANDOFF.md` (uses Haiku). The band also has a **handoff** button, and offers the saved next steps as one-key buttons in the next session. |

Rewrite and read costs are estimates from Anthropic list prices hard-coded in `hooks/register.js` (`basePrice`); Bedrock or managed pricing can differ. Token totals come from `scripts/tokens.mjs`, which reads the session transcript with Node (`node` must be on `PATH`, `/usr/local/bin` or `/opt/homebrew/bin`).

## Develop

```bash
claude --plugin-dir ./usage-band        # load a mod from disk; saves hot-reload
claude plugin validate .                # marketplace + manifests
claude plugin validate ./<mod>
claude plugin test ./usage-band         # only usage-band has tests
```

See [AGENTS.md](AGENTS.md) for conventions.
