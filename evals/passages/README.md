# Book passages

Does a passage of a long file come back on the right page? `run.mjs` splits
one public-domain book with `app/concepts/asset-passages.ts` and asks 20
questions of the form "what does Mill say about X", scoring whether the
printed page holding the answer is in the top three.

- `make_book.py` lays out Project Gutenberg's *On Liberty* (#34901) as a
  141-page A5 PDF with two unnumbered front-matter pages, so printed and file
  page numbers differ. `uv run --with reportlab python make_book.py liberty.txt on-liberty.pdf`.
- `on-liberty.md` is that PDF as Workers AI `toMarkdown` returned it on
  2026-10-29: 71k tokens, `### Page N` per file page, printed numbers glued
  to the first word of each page.
- `on-liberty.json` holds the questions and a phrase from each answer; the
  truth is the file page holding the phrase, minus the front matter.

```sh
node evals/passages/run.mjs --out evals/passages/<date>-run.json
```

Without `OPENROUTER_API_KEY` it runs the lexical mode only.

## 2026-10-29

129 passages, 127 with printed pages. Top three, of 20:

| Mode | Found |
| --- | --- |
| lexical, the question as asked | 12 |
| lexical, terms rewritten by claude-haiku-4.5 | 12 |
| bge-m3 cosine | 17 |
| reciprocal rank fusion of lexical and bge-m3 | 18 |

Cost $0.003 through OpenRouter. The index is node:sqlite FTS5 with the
production tokenizer and weights, not D1, and fusion is not production's Jev
rerank. A loopback run of the real Worker with real Workers AI conversion and
metadata, searching through MCP `search` in lexical mode, also found 12 of 20.
Questions name the author, and in the lexical fallback "Mill" matches the
title page and the asset row; that is where the misses go. Rewriting helps
the questions whose answer uses a term the question avoids ("tyranny of the
majority", "infallibility") and hurts those it turns into general terms.
`2026-10-29-run.json` has every ranking.
