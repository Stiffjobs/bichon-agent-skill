# Bichon Skill

Agent skill for running Bichon campaign intake, research analysis and post
writing from a local agent (Claude Code, Codex, or any agent that can run a
shell command). The agent reads a campaign's context and collected research
through the Bichon agent API, analyzes the research, does the thinking and
writing itself, and submits analyses and posts (each with one caption per
target account) back.
Bichon stays the system of record: managers review, schedule and publish in
the dashboard. The skill never publishes.

## Files

- `skills/bichon/SKILL.md`: the skill: intake, workflow, post and caption rules, bundle formats, bounds and errors
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
(Members page, API keys card). Then:

```bash
./skills/bichon/scripts/bichon.cjs setup --api-key bichon_org_<secret>
./skills/bichon/scripts/bichon.cjs brands --pretty
```

`setup` verifies the key and saves it to `~/.config/bichon/config.json`
(`--local` for `./.bichon/config.json`). `BICHON_AGENT_API_KEY`,
`BICHON_CONFIG_PATH` and `BICHON_AGENT_BASE_URL` override the saved config;
`setup --base-url <url>` points the skill at another deployment.

New campaign: ask the agent to set one up ("start an autumn campaign for <brand>"); it reads
`brand:context` and `personas:draft`, interviews you, and runs `campaigns:create` once you confirm its summary.

Research: before writing posts, the agent analyzes what Bichon collected for the
campaign (articles, competitor posts, Threads posts). It leases batches with
`research:pending`, hands each batch to an analyst subagent (in Claude Code,
one Opus subagent per batch, several in parallel) and stores the results with
`research:submit` until nothing is pending. Posts cite analyzed items
only; ask for a fresh collection ("collect new research for the autumn
campaign") when the sources are stale.

Capture: the agent can also add what it reads itself. Ask it to look at an
account, a site or a topic ("read @example_roasters' last ten TikToks", "find
forum threads about sour pour-over"); it reads the pages with its own browser
or web tools, hands them in with `research:add`, and analyzes them like any
collected item before citing them.

Review loop: after reviewing drafts in the dashboard (campaign → Review posts), ask the agent to "address the review comments"; it runs `reviews`, rewrites each caption with a `responseNote` and resubmits it as the next revision.

## Example Run

Inside an agent session, ask for it in plain words ("write posts for the
autumn campaign"). Under the hood the agent runs:

```bash
S=./skills/bichon/scripts/bichon.cjs
$S campaigns --brand <brandId>
$S context --campaign <campaignId> --out work/context.json
$S research:pending --campaign <campaignId> --limit 25 --out work/batch-1.json
# one analyst subagent per batch writes work/analyses-1.json (ResearchAnalysisBundle)
$S research:submit --campaign <campaignId> --file work/analyses-1.json
# → { stored, rejected, remaining }; repeat until nothing is pending
$S evidence --campaign <campaignId> --q "sour pour-over fixes" --limit 20
$S competitors --brand <brandId>
# the agent writes work/posts.json (PostsBundle, see SKILL.md): up to five
# posts, each with its brief, a reviewNote and one caption per target account
$S posts:submit --campaign <campaignId> --file work/posts.json
# → { runId, accepted: [{ ideaId, drafts: [{ draftId, voiceCheck }] }], rejected: [{ code, reason }] }
$S draft:media:add --id <draftId> --file work/card1.png   # image posts: once per image
# the agent rewrites any caption with failed voice checks in work/drafts.json
$S drafts:submit --idea <ideaId> --file work/drafts.json
$S draft:submit --id <draftId>   # optional: send to manager review
$S reviews --campaign <campaignId>   # after the manager's review: requests to answer
```

Every command prints `{"ok":true,"data":...}` or, with exit code 1,
`{"ok":false,"error":{"code","message","details?"}}`. `schema` prints the JSON
Schemas of the bundles (posts, drafts, campaign setup, personas,
research analyses, research captures), and `--dry-run` validates a bundle without sending it.

## Tests

```bash
node --test tests/
```

## License

Released under the MIT License. See `LICENSE`.
# bichon-agent-skill
