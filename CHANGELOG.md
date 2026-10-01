# Changelog

Versions are identified by the `last-updated` date in `skills/bichon/SKILL.md`.
Run `npx skills update bichon` to get the latest.

## 0.8.0 (2026-10-02)

- Ads commands, all under `--brand <id>` and backed by
  `/agent/v1/brands/:brandId/ads`:
  - `ads:account`: the connected Meta ad account (`currency`,
    `timezoneName`, `budgetUnitsPerCurrency`), its Pages with linked
    Instagram accounts, and pixels.
  - `ads:insights [--level account|campaign|adset|ad] [--range <preset>]
    [--since YYYY-MM-DD --until YYYY-MM-DD] [--daily] [--breakdown <b>]
    [--campaign|--adset|--ad <id>] [--limit 1..500]`: performance rows;
    `--range` with `--since`/`--until`, or only one of the two dates, is
    rejected locally.
  - `ads:list --kind campaigns|adsets|ads|creatives [--campaign <id>]
    [--adset <id>] [--limit 1..200]`.
  - `ads:create --kind campaign|adset|creative|ad --file params.json
    [--dry-run]` and `ads:update --kind campaign|adset|ad --id <metaId>
    --file patch.json [--dry-run]`: Meta Marketing API fields, checked
    locally against the server's allowlist (unknown or missing fields, a
    `status` other than `PAUSED`, money that is not a positive integer,
    fields fixed at creation).
  - `ads:media:add --file <jpg|png|mp4|mov> [--name <name>]`: images up to
    8 MB, videos up to 200 MB, uploaded the way `draft:media:add` uploads;
    `ads:media [--kind image|video] [--limit 1..200]` lists them.
  - `ads:targeting --type interest|geo|locale --q <text>`.
- Meta ids (`--campaign`, `--adset`, `--ad`, `--id`) must be digit strings.
- Storage uploads (`draft:media:add` too) now time out after 10 minutes
  instead of 2, for large videos.
- SKILL.md gains an Ads section: the prerequisite connection, reading and
  reporting performance, the build order with one example per kind, and the
  rules (everything paused, only a manager activates, money in the smallest
  currency unit, new creative instead of an edit, Taiwan and EU advertiser
  identity, `meta_rejected`). The skill also triggers for ads work.
- SKILL.md documents two server defaults: a campaign with no budget of its
  own (budget on the ad sets) gets `is_adset_budget_sharing_enabled: false`
  unless set, and a new ad set without `targeting.targeting_automation` gets
  `{ advantage_audience: 0 }`, so the targeting is used as written. Params
  target Meta Marketing API v25.0.
- Needs the Bichon server release that has the `/brands/:brandId/ads`
  routes; older servers have no route for the `ads:*` commands.

## 0.7.0 (2026-10-01)

- `research:add --campaign <id> --file captures.json [--dry-run]` hands in
  pages and posts the agent read itself (`bichon-research-captures/v1`,
  `schema --bundle captures`): at most 25 items per call and 300 per
  campaign, each with `kind`, `url` and the verbatim `text`; posts also need
  `username`. It posts to `POST /agent/v1/campaigns/:id/research/captures`
  and returns `{ added, updated, unchanged, rejected, captured, limit }`.
- Captured items are pending research like collected ones: lease them with
  `research:pending`, analyze, `research:submit`, then cite the `signalId`
  and `versionId` that `evidence` returns.
- SKILL.md gains a Capture section and the `research:add` rejection codes.
- `posts:submit` documents the duplicate check: `plan.near_duplicate`
  rejections and the `plan.possible_duplicate` / `plan.duplicate_unchecked`
  warnings on accepted posts.
- Needs the Bichon server release that has
  `POST /campaigns/:id/research/captures`; older servers have no route for
  `research:add`.

## 0.6.0 (2026-10-01)

- `posts:submit --campaign <id> --file posts.json [--dry-run]` replaces
  `ideas:submit`: one call stores the run, each accepted post's brief and its
  captions, and voice-checks the drafts. It posts to
  `POST /agent/v1/campaigns/:id/posts`; `--dry-run` reports
  `bundle: 'posts'` with `posts` and `drafts` counts.
- The bundle is `bichon-posts/v1` (`schema --bundle posts`): `posts[]`, at
  most 5, each post is the old idea fields plus an optional `reviewNote`
  (at most 300 chars, what the manager should check) and `drafts[]` (1–10,
  one caption per target account). A `bichon-ideation-run/v1` bundle is
  refused with a hint to use `posts:submit`; `noIdeasReason` is now
  `noPostsReason`.
- `drafts:submit --idea` rewrites a stored post's drafts or adds drafts for
  accounts it has none for. `run:get` and `ideas` stay.
- `context.limits.maxIdeas` is now `maxPosts`.
- The `assigned` idea status is gone; `ideas --status assigned` is rejected.
- A rejected draft is final: it can no longer be rewritten or resubmitted.
  The post is discarded once every account's draft is rejected.
- `reviews` returns at most 50 drafts, as the server does.
- Breaking: needs the Bichon server release that has
  `POST /campaigns/:id/posts`; older servers have no route for
  `posts:submit`.

## 0.5.0 (2026-10-01)

- `draft:media:add --id <draftId> --file <image>` uploads a JPEG, PNG or
  WebP (at most 8 MB) and attaches it as the draft's next image;
  `draft:media:remove --id <draftId> --media <mediaId>` removes one.
- `draft:get` returns each image's `mediaId`, `contentType` and
  `errorMessage` next to `kind`, `status` and `order`.
- The workflow attaches an `image` post's images before hand-over, and the
  review loop replaces an image a request asks to change. The studio is gone:
  images come from the agent.

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
