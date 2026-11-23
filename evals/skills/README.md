# Real-client skill probes

These probes distinguish native skill registration, ordinary resource reads,
skill-tool calls, and MCP prompt commands. A model returning the right text
does not establish native skills-over-MCP support.

## Run

Run from the repository root with Node and the named client on PATH. Claude
and Codex use their existing model login and consume plan usage. The fixture
has no credentials, network access, or access to Valise data. No skill files
are installed. Scratch transcripts remain in the printed temporary directory;
compact evidence goes to `evals/skills/runs/`.

```sh
node evals/skills/probe.mjs claude native
node evals/skills/probe.mjs codex native
VALISE_PROBE_PROTOCOL=modern node evals/skills/probe.mjs claude native
VALISE_PROBE_PROTOCOL=modern node evals/skills/probe.mjs opencode native
node evals/skills/probe.mjs claude prompts explicit
node evals/skills/probe.mjs opencode all explicit
node evals/skills/probe.mjs claude tools plain
node evals/skills/probe.mjs claude tools nudge
node evals/skills/probe.mjs claude tools nudge-unrelated
node evals/skills/probe.mjs codex tools plain
node evals/skills/probe.mjs codex tools nudge
node evals/skills/probe.mjs codex tools nudge-unrelated
node evals/skills/remote.mjs
```

Repeat a command to obtain independent samples. `VALISE_PROBE_TMP` overrides
the scratch-directory parent. `VALISE_PROBE_PROTOCOL=modern` enables the
2026-07-28 discovery response; otherwise a client probing that method falls
back to the legacy initialize handshake. Both expose the skills extension.

`npm run test:clients` checks the fixture with the installed MCP client SDK.
It negotiates legacy and pinned `2026-07-28` connections, then lists and loads
instructions through tools, prompts, and resources. These checks consume no
model quota. Protocol decoding is required in addition to content equality.

The modes add surfaces around the same instruction:

| Mode | Skills extension and resources | Tools | Prompts |
| --- | --- | --- | --- |
| native | yes | no | no |
| tools | yes | yes | no |
| prompts | yes | no | yes |
| all | yes | yes | yes |

`native` means the fixture offers the extension, not that the client used it.
Inspect `methods`, `registeredSkills`, and `registry`. `resources/read` alone
is resource access. `skills/list` is evidence of extension discovery, but
registration and verified loading still need separate observations.

Claude uses headless print mode, an isolated MCP config, no user/project
settings, and only skill, tool-search and resource tools. It retains built-in
skills. `explicit` invokes `/mcp__valiseprobe__valise-probe-cerulean`.
`nudge` and `nudge-unrelated` deliver the candidate text through an actual
SessionStart hook passed in per-run settings.

Codex ignores user config and execpolicy rules, disables hooks, uses a
read-only sandbox, and preapproves only the fixture's MCP tools. It can still
discover existing local skills; the unique fixture name prevents a same-name
local skill from satisfying this test. Its nudge is delivered through
`developer_instructions`: a wording probe, not a Codex hook-lifecycle test.
Its model is the client's default. `explicit` uses `$valise-probe-cerulean`.

OpenCode probes the real service's registries without calling a model. It
adds a runtime-only MCP server at a unique temporary Location, reads the
skill registry (plain) or command registry (explicit), then removes that
server. Global local skills can appear in the response but only the unique
fixture's entries are retained in evidence. Config discovery alone does not
start the connection for these API calls, so registration uses the documented
runtime MCP API. Output goes directly to a file to avoid truncated large
registry responses on piped stdout in the tested CLI.

`remote.mjs` reads the public SkillsOverMCP template endpoint's initialization,
tools, prompts, resources, and skills listings. It does not execute its skills.

## Findings, 2026-10-19

Versions: Claude Code 2.1.303 (Haiku 5.5), Codex CLI 0.163.0, OpenCode 2.0.32.

| Probe | Observation |
| --- | --- |
| Claude native, legacy and modern | Reads the skill as an ordinary resource. No `skills/list` or `skills/get`; fixture absent from native skills and command lists. Modern response quoted the receipt rather than returning only the requested marker. |
| Codex native, legacy | Lists and reads ordinary resources and returns the receipt. No extension methods observed. This does not test its interactive skill picker. |
| OpenCode native, modern | Connects through `server/discover`, lists resources, and returns no fixture entry in `/api/skill`. No `skills/list`; no body reads during registry inspection. |
| Claude prompt | Registers `mcp__valiseprobe__valise-probe-cerulean`; explicit invocation calls `prompts/get` and returns the exact marker. |
| OpenCode prompt | Registers `valiseprobe:valise-probe-cerulean` in `/api/command`; registry inspection does not read the body. This verifies the command registry, not an interactive screenshot or command execution. |

The short `/valiseprobe:valise-probe-cerulean` spelling failed in the tested
Claude print invocation despite appearing in current documentation. The full
`/mcp__valiseprobe__valise-probe-cerulean` spelling succeeded. Preserve the
actual registered name rather than guessing an alias.

OpenCode's existing `conversation-history` entry was separately traced via
`/api/skill` to `~/.agents/skills/conversation-history/SKILL.md`. The working
`@conversation-history` therefore comes from filesystem discovery. Valise's
live `list_skills` also lists that name, but that is a separate registration.

## SessionStart candidate

> Valise skills are also available as MCP tools named skill_\<name\>. When a
> skill fits the task, call its tool to read the instructions before doing
> the work. Load only the skill you need.

The tools-only fixture is intentionally easy: one relevant skill, no rival
tool descriptions. Claude loaded the skill with and without the real hook.
Codex's three approved baseline runs loaded the skill 1/3 times; the three
nudged runs loaded it 3/3 times (runs at 18:06, 18:07, and 18:08). Claude
loaded it in both baseline runs and both nudged runs. Both clients answered
arithmetic without loading it when nudged.
This is feasibility evidence, not a statistically established improvement.
Use repeats and the existing distractor evals before changing the shipped
hook. The hook cannot register a slash command or populate a skill picker.

MCP initialization `instructions` is a more portable place for this short
explanation than requiring a lifecycle plugin in each harness. OpenCode
documents including those instructions in model context. A follow-up A/B
should compare server instructions against the hook, including distractors
and no-skill controls. Avoid duplicating the entire skill catalog in either.

## SkillsOverMCP comparison

The first public-template probe at 18:04:56 succeeded; its extracted
observations are in `skillsovermcp-observed.md`. A rerun at 18:10 returned
HTTP 500 because the service's GitHub account hit a rate limit; that response
is retained in `runs/skillsovermcp-catalog.json`. The website recommends
tools + prompts + resources today. The successful probe observed:

- exposes six per-skill tools and a `read_skill_file` tool;
- exposes six skill prompts plus an about prompt;
- exposes an index and skill resources;
- sends initialization instructions naming its skills and explaining that
  a tool call loads instructions, with supporting files fetched on demand;
- advertises the extension under `experimental` in the legacy handshake;
- returns `-32601 Method not found` to `skills/list` in this connection.

The site claims native Claude Code support. Neither this legacy endpoint
probe nor our actual-client probes establish that claim. The useful practices
to adopt are prompt exposure and a concise discovery explanation, while
retaining Valise's existing extension handlers and lazy instruction tools.

## Evidence limits and setup failures

Early OpenCode runs at 18:04 and 18:05 have empty protocol traces because a
standalone registry request did not connect the configured server. They are
setup failures, not negative support results. The 18:06:35 prompt-registry and
18:07:23 modern native-registry runs use explicit runtime registration.

Early Codex tools runs at 18:05:27 and 18:05:31 attempted a tool but were
blocked by approval policy. Later runs explicitly approve the fixture tools;
only those belong in wording comparisons. Early `markerReturned` fields
looked for the marker anywhere in stdout; later runs with `finalText` require
an exact final answer. Read protocol routes for retrieval, not that early
field. Raw local stdout/stderr paths remain in each record for diagnosis.

These are stdio fixture probes, not end-to-end authenticated Valise HTTP
tests. The existing Worker tests cover Valise's protocol handlers. Interactive
autocomplete rendering, client feature-flag cohorts, supporting-file loading,
mid-session catalog refresh and stale-cache handling remain unmeasured.

## Sources

- https://skillsovermcp.com/
- https://modelcontextprotocol.io/extensions/skills/overview
- https://modelcontextprotocol.io/extensions/client-matrix
- https://opencode.ai/v2/docs/mcp-servers
- https://opencode.ai/v2/docs/skills
- https://code.claude.com/docs/en/mcp
- https://developers.openai.com/codex/build-skills
