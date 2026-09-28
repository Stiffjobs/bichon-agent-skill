# Changelog

Versions are identified by the `last-updated` date in `skills/bichon/SKILL.md`.
Run `npx skills update bichon` to get the latest.

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
