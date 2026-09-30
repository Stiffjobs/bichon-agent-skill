# Changelog

Versions are identified by the `last-updated` date in `skills/bichon/SKILL.md`.
Run `npx skills update bichon` to get the latest.

## 0.4.0 (2026-09-30)

- `reviews --campaign <id> [--status changes_requested|submitted|approved|all]
  [--history]` lists the campaign's drafts under review (default
  `changes_requested`, at most 50) with `revision`, `reviewNote` and
  `requests`: the manager's and client's comments on the current revision
  (`--history` for every revision), with decision and expiring image URLs.
- `draft:get` also returns `revision` and `requests`.
- DraftsBundle entries accept an optional `responseNote` (at most 1000
  chars): what the rewrite changed, stored on the draft's next revision.
- SKILL.md gains a Review loop step after Hand over: read every request and
  its images, rewrite the caption, add a `responseNote`, `drafts:submit`
  (withdraws a submitted draft), then `draft:submit` for the next revision;
  two rounds per session. Approved drafts cannot be rewritten (409
  `draft_status`).
- `threads` returns `{ keywords, items, pendingCount }`; Threads findings
  are gone.

## 0.3.0 (2026-09-29)

- The account playbook is part of the server's channel analysis.
  `analysis:request --brand <id> --profile <socialProfileId>` replaces
  `playbook:request`; there is no approval step.
- Context accounts carry `analysisStatus`, `analysis` (formats with
  `skeleton`, `openers` and `modelPosts`, `rules`, `fingerprintLine`),
  `voice` and `managerNotes`. `playbook`, `playbookStatus`, `usage`,
  `recentPosts`, `audience` and post metrics are gone.
- SKILL.md: `layoutModelPostId` must be one of the format's
  `modelPosts[].externalId`; captions follow the format's skeleton and model
  post and `analysis.rules`, with `managerNotes` first; drafts are
  voice-checked when the account has a ready analysis.
- Local research analysis: `research:collect`, `research:runs`,
  `research:pending` (`--out` writes the leased batch to a file),
  `research:submit` and `research:sources`. ResearchAnalysisBundle files are
  validated locally (`--dry-run` validates only; `schema --bundle research`).
- SKILL.md gains a Research section: collect, lease batches, one Opus analyst
  subagent per batch in parallel (sequential without subagents), submit until
  nothing is pending. It carries the analyst brief as a template and a
  validated ResearchAnalysisBundle example.
- `evidence`, `threads` and `competitors` return analyzed items only;
  `evidence --kind` filters by item kind, and `context --out` reports the
  research counts.
- Ideation: evidence entries cite `{ signalId, versionId?, reason, excerpt? }`
  or `{ discoveryId, reason }`; unanalyzed items are rejected
  (`evidence_not_analyzed`). `active_discussion` replaces
  `growing_discussion`, which is rejected; `competitor_performance` needs a
  cited competitor post with an engagement read. No trend claims.

## 0.2.0 (2026-09-29)

- Campaign intake: `brand:context`, `personas:draft`, `personas:set`,
  `campaigns:create`, `campaigns:update` (`--impact-key`) and `threads`.
- CampaignSetup and personas files are validated locally against the API
  bounds (`--dry-run` validates only); `schema --bundle setup|personas`
  prints their JSON Schemas.
- A 409 `impact_confirmation` from `campaigns:update` is printed unchanged
  (with `impactKey` and `impact`) so the agent can confirm with the manager
  and resubmit.
- `playbook:request` asks the server to build an account playbook; SKILL.md
  checks every target account's playbook after loading context and points the
  manager to the Connections page to approve it. Without an approved playbook
  the account keeps `voice` and `recentPosts`, and its `formatPlan` entries
  are ignored.
- SKILL.md gains an Intake section: fill the gaps of an existing campaign, or
  interview the manager for a new one against the brand's data and create it
  after a confirmed summary.

## 0.1.0 (2026-09-28)

- First release against the Bichon agent API v1 (`/agent/v1`).
- Commands: `setup`, `config`, `health`, `brands`, `campaigns`, `context`
  (`--out` to a file), `evidence` (semantic `--q`), `competitors`, `ideas`,
  `ideas:submit`, `run:get`, `drafts:submit`, `draft:get`, `draft:submit`,
  `schema`.
- `ideas:submit` and `drafts:submit` validate bundles locally against the API
  bounds before sending and report every offending path; `--dry-run` validates
  only.
- SKILL.md carries the ideation discipline (persona → reader POV → core
  message → format plan, claim and why-now rules) and the caption rules
  (playbook skeleton and model post, channel voice, content language, voice
  check repair loop).
- Config resolution: `BICHON_AGENT_API_KEY`, `--config` / `BICHON_CONFIG_PATH`,
  nearest `.bichon/config.json`, `~/.config/bichon/config.json`. Base URL from
  `BICHON_AGENT_BASE_URL`, `setup --base-url`, or the production default.
