Recent work, for orientation only; search or fetch before relying on any of it.

Projects worked on last: valise, blog, homelab.

Recent to-dos:
- Give one to-do and one skill a console URL, so the logs pane can link their ids · valise · area:console, area:logs
- Make blocked to-dos visible and unblockable without opening the row · valise · console, todos, blocked, area:console
- Write a blog post on logging an MCP server: what to record per call, and which metadata clients already send · blog · mcp, observability, logging, writing
- Nightly backup export of the authoritative tables to R2 · valise · ops, backup, d1, r2
- Move the homelab Prefect flows off the NAS cron and onto Prefect schedules · homelab · prefect, nas, scheduling

Memories, most fetched in the last 30 days:
- memory:mem_c77d6891-01a4-4e58-b64c-0757afe2e467 Console list search uses instr(), not LIKE and not the FTS index, because D1 caps LIKE patterns at 50 bytes
- memory:mem_ee1b8200-3515-4abf-b919-76c0154eff26 Valise search: one shared FTS5 corpus with BM25, not per-concept indexes plus RRF
- memory:mem_5a30e0af-8365-4a90-9983-b2e24006aa06 In the valise repo, squash-merging a PR with --delete-branch closes any PR stacked on it, so land stacks bottom-up from fresh main instead
