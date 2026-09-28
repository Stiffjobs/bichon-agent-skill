# Bichon Skill

Agent skill for running Bichon campaign ideation and caption drafting from a
local agent (Claude Code, Codex, or any agent that can run a shell command).
The agent reads a campaign's context and research through the Bichon agent
API, does the thinking and writing itself, and submits ideas and drafts back.
Bichon stays the system of record: managers review, schedule and publish in
the dashboard. The skill never publishes.

## Files

- `skills/bichon/SKILL.md`: the skill: workflow, ideation and caption rules, bundle formats, bounds and errors
- `skills/bichon/scripts/bichon.cjs`: zero-dependency Node CLI (Node 18+)
- `tests/`: `node:test` suite against a local HTTP stub

## Install With `npx skills add`

```bash
npx skills add Stiffjobs/bichon-agent-skill
```

The repository exposes the standard `skills/bichon/SKILL.md` layout that the
`skills` CLI discovers.

## Update

```bash
npx skills update bichon
```

Run `npx skills update` with no arguments to update every installed skill;
add `-g` for a global install or `-p` for a project install. Re-running
`npx skills add Stiffjobs/bichon-agent-skill` also overwrites the installed
copy. The `last-updated` date in `skills/bichon/SKILL.md` shows which version
you have; `CHANGELOG.md` lists what changed.

## Quick Start

A workspace owner or admin creates an API key in the Bichon dashboard
("Run locally" panel). Then:

```bash
./skills/bichon/scripts/bichon.cjs setup --api-key bichon_org_<secret>
./skills/bichon/scripts/bichon.cjs brands --pretty
```

`setup` verifies the key and saves it to `~/.config/bichon/config.json`
(`--local` for `./.bichon/config.json`). `BICHON_AGENT_API_KEY`,
`BICHON_CONFIG_PATH` and `BICHON_AGENT_BASE_URL` override the saved config;
`setup --base-url <url>` points the skill at another deployment.

## Example Run

Inside an agent session, ask for it in plain words ("run ideation for the
autumn campaign and draft captions for the accepted ideas"). Under the hood the
agent runs:

```bash
S=./skills/bichon/scripts/bichon.cjs
$S campaigns --brand <brandId>
$S context --campaign <campaignId> --out work/context.json
$S evidence --campaign <campaignId> --q "sour pour-over fixes" --limit 20
$S competitors --brand <brandId>
# the agent writes work/run.json (IdeationRunBundle, see SKILL.md)
$S ideas:submit --campaign <campaignId> --file work/run.json
# → { runId, accepted: [{ ideaId, ... }], rejected: [{ code, reason }] }
# the agent writes work/drafts.json with one caption per target account
$S drafts:submit --idea <ideaId> --file work/drafts.json
# → drafts[].voiceCheck findings; the agent repairs and resubmits
$S draft:submit --id <draftId>   # optional: send to manager review
```

Every command prints `{"ok":true,"data":...}` or, with exit code 1,
`{"ok":false,"error":{"code","message","details?"}}`. `schema` prints the JSON
Schemas of both bundles, and `--dry-run` validates a bundle without sending it.

## Tests

```bash
node --test tests/
```

## License

Released under the MIT License. See `LICENSE`.
