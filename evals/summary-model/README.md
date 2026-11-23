# Summary model

Which Workers AI model should write file metadata and bookmark summaries?
`run.mjs` sends the same pages and book to each model through the production
prompts, parsers and article fetch, which `probe.ts` runs in a loopback
Worker with real page fetches and real Workers AI. It records whether the
reply passes the production schema, how long the call took, and its tokens
and cost at list price.

```sh
cd evals/summary-model && npx wrangler dev --port 8797     # one terminal
node evals/summary-model/run.mjs --out evals/summary-model/<date>-run.json
node evals/summary-model/run.mjs --models glm,gemma         # a subset
```

Prices and context sizes in `run.mjs` come from
`npx wrangler ai models list --json`. Read that list again before a new run.
Faithfulness and concept usefulness are judged by reading the `parsed`
replies in the run file against the page.

## 2026-10-29

Catalog read 2026-10-29. Prices are USD per million input and output tokens.
The models were Llama 3.3 70B fp8-fast ($0.293/$2.253, 24k context,
released 2024-12), the model in production at the time. The candidates were
GLM 5.3 Flash ($0.15/$0.50, 1M, 2026-08), DeepSeek V4.1 Flash 1017
($0.30/$1.20, 1M, 2026-10) and Gemma 4 26B A4B ($0.10/$0.30, 256k, 2026-04).
Each ran with temperature 0 and JSON mode. Reasoning was off for DeepSeek
(`reasoning_effort: "none"`) and Gemma (`enable_thinking: false`). GLM cannot
turn reasoning off, so it ran at `reasoning_effort: "low"`; its reasoning
tokens count as output.

The input was 11 public pages and one book. The pages were 8 Wikipedia
articles, the Gutenberg catalog page for *Frankenstein*, and the Gutenberg
HTML of *On Liberty* and *The Wealth of Nations*. The book is
`../passages/on-liberty.md`, the `toMarkdown` output of a 141-page PDF with
71k tokens. Bookmarks ran at production's 8 KiB prefix and at 32 KiB. The
book ran through the file metadata prompt at production's 12 KiB prefix, and
whole for the models whose context holds it.

Bookmarks, 8 KiB prefix, 500 output tokens, 25 s deadline:

| Model | Valid JSON | Faithful | p50 | Max | Cost per page |
| --- | --- | --- | --- | --- | --- |
| llama-3.3-70b-instruct-fp8-fast | 4/11 | yes, where parsed | 14.6 s | 20.3 s | $0.00137 |
| glm-5.3-flash | 11/11 | yes | 3.8 s | 14.6 s | $0.00037 |
| deepseek-v4.1-flash-1017 | 11/11 | yes | 2.2 s | 2.7 s | $0.00074 |
| gemma-4-26b-a4b-it | 11/11 | yes, generic | 2.4 s | 5.9 s | $0.00023 |

At a 32 KiB prefix, Llama parsed 5/11 and the three candidates 11/11. GLM
took 4.2 s p50 and 9.6 s max at $0.00115 a page. DeepSeek took 3.0 s and
4.6 s at $0.00226. Gemma took 2.6 s and 3.4 s at $0.00079.

The book through the file prompt, 900 output tokens, 10 s deadline:

| Model | 12 KiB prefix | Whole book, 65k tokens in |
| --- | --- | --- |
| llama-3.3-70b-instruct-fp8-fast | valid, 7.2 s, $0.00100 | does not fit 24k |
| glm-5.3-flash | valid, 2.7 s, $0.00042 | valid, 4.8 s, $0.00990 |
| deepseek-v4.1-flash-1017 | valid, 1.8 s, $0.00086 | valid, 8.0 s, $0.01987 |
| gemma-4-26b-a4b-it | valid, 2.2 s, $0.00029 | valid, 12.6 s, $0.00687 |

Llama's 13 failures across both prefixes are not malformed JSON. In 10 of
them the reply ran past the 500-token limit mid-string ("Unterminated
string", `finish_reason: length`). Twice it stopped mid-string at only 965
and 623 characters. Once `concepts` came back as a string. In production a
failed bookmark is charged its ceiling, waits a day, and stops after three
tries, so most bookmarks would never get a summary.

Faithfulness was spot-checked against the prefix each model was given. Every
specific claim GLM made on Jevons paradox, Mycorrhiza and Dunbar's number is
in the text. Those claims include green taxes and cap-and-trade, the
reservoir effect, A.B. Frank in 1885, 450 to 500 million years, Brassicaceae
losing the association, 70% of plant species, and Bernard and Killworth's
290. DeepSeek is as specific. Gemma is accurate but generic. Its concepts
read like subject tags ("cognitive limit", "economic growth"), and it
summarised the *Wealth of Nations* table of contents as the whole book.
GLM's concepts name the page's own ideas ("Khazzoom–Brookes postulate",
"Rhynie chert fossil evidence", "Language as social grooming"), sometimes as
longer phrases than asked. Reading the whole book changed the concepts more
than the summary. GLM and DeepSeek both found "harm principle" only in the
whole book. The 12 KiB prefix ends in the introduction.

Latency did not grow with input. GLM ran the book 4 times each at 12, 32, 64
and 128 KiB and whole. The medians were 4 to 7 s at every size. 5 of the 24
GLM file calls in that series, the trial and the run took 11.6 to 19.7 s,
past the 10 s file metadata deadline. A missed deadline leaves the
extraction and passages intact, with no suggestions and a retry offered.
Llama's four 12 KiB repeats took 4.0 to 5.3 s. GLM's bookmark calls stayed
under the 25 s deadline. The slowest was 24.0 s, in the trial run; every
other call took 16.3 s or less.

### Choice

GLM 5.3 Flash, the owner's pick. The run found no reason to overrule it.
Every reply parsed. Its summaries are faithful and its concepts are the most
specific of the four. A page costs about a quarter of Llama's at 8 KiB and
less than Llama's 8 KiB cost at 32 KiB. DeepSeek is as good and faster, but
costs twice as much per page. Gemma is cheapest, with the weakest concepts.
GLM's one weakness is its latency tail against the 10 s file deadline.

With the 1M context, bookmarks now read 32 KiB and files 64 KiB. One
bookmark at 32 KiB costs about $0.0012, so the default $0.25 daily budget
covers about 200 a day. The budget admits a bookmark against a worst case
of one token per byte, 5319 micro-dollars. The model, prices, catalog date
and both prefixes are in `app/concepts/summary-model.ts`.

The comparison cost $0.144 (`2026-10-29-run.json`). Including the GLM trial,
the latency repeats and one scheduler tick on loopback, the session spent
about $0.25.

## 2026-11-01, image tokens

`probe.ts` takes `POST /image` with `{"b64": <PNG as base64>}` and sends it
to glm-5.3-flash as an `image_url` data URL with a one-sentence prompt.
Square gradient PNGs, `reasoning_effort: "low"`:

| Image | Prompt tokens | Time |
| --- | --- | --- |
| 256 px | 121 | 1.3 s |
| 1,024 px | 1,390 | 1.2 s |
| 2,048 px | 5,062 | 2.3 s |

About 1,200 tokens per megapixel at list price $0.15 per million, so a 2,048
px photo adds under $0.001. Gradients are not photographs; this measures
cost, not whether the description is faithful.
