# SkillsOverMCP observation, 2026-10-19 18:04:56 UTC

Endpoint: https://mcp.skillsovermcp.com/mcp/spencerpauly/skills-repo

These are observations extracted from the successful probe's printed summary,
not a reconstructed JSON-RPC response. A later probe overwrote the original
catalog file with an HTTP 500 response; that failed response is retained.
The first probe did not send `notifications/initialized`. The current script
does, but its rerun failed at initialization because of the upstream rate limit.

`initialize` returned protocol `2025-11-25`, server name
`skillsovermcp/spencerpauly/skills-repo`, server version `9b95990`, and:

```json
{
  "experimental": { "io.modelcontextprotocol/skills": {} },
  "tools": { "listChanged": true },
  "prompts": { "listChanged": true },
  "resources": { "listChanged": true }
}
```

Its initialization instructions began:

> You are connected to skills hosted by skillsovermcp.com, sourced from the
> GitHub repository spencerpauly/skills-repo at ref main.
>
> Each skill is a structured how-to for a specific task. When the user's
> request matches one of these skills, call its tool to load the full
> SKILL.md instructions.

It then listed six skill tools and abbreviated descriptions. It ended:

> Loading a skill returns its SKILL.md body. Skills may reference supporting
> files (e.g. references/GUIDE.md, scripts/extract.py) — load those with
> read_skill_file(slug, path) when needed.

`tools/list` returned `skill_ask_database`, `skill_grill_me`, `skill_review_pr`,
`skill_suggesting_skills`, `skill_triage_bug`, `skill_write_like_a_human`, and
`read_skill_file`. Descriptions described when to use the skills; bodies were
not present in the descriptions shown by the probe.

`prompts/list` returned `_skillsovermcp_about`, `ask-database`, `grill-me`,
`review-pr`, `suggesting-skills`, `triage-bug`, and `write-like-a-human`.

`resources/list` returned `skill://index.json`, the six SKILL.md resources
under `skill://spencerpauly/skills-repo/<name>/SKILL.md`, and
`skill://spencerpauly/skills-repo/review-pr/references/checklist.md`.

`skills/list` returned error code `-32601`, message `Method not found`.
This is a legacy-connection observation, not a conformance verdict for every
transport or protocol revision supported by the service.
