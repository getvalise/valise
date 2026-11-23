# Bookmark passages

Do vectors help bookmarks the way they helped a book? `run.mjs` splits ten
public web pages with `app/concepts/asset-passages.ts`, the splitter the
Worker runs on a bookmark's article, and asks 20 paraphrased questions,
two per page. Each question avoids its answer's wording where it can. A
question scores when the passage holding the answer, or any passage of the
right bookmark, is in the top three.

- `pages.json` holds ten Wikipedia articles on overlapping farming topics
  (hedges, pollination, windbreaks, cover crops, agroforestry, crop
  rotation, companion planting, soil erosion, beekeeping, permaculture),
  fetched on 2026-11-01 as MediaWiki plain-text extracts, with each URL and
  revision. CC BY-SA 4.0, Wikipedia contributors. The overlap is the point:
  every question has plausible wrong pages.
- `questions.json` holds the questions, the page, and a verbatim phrase
  from each answer; the truth is the passage holding the phrase.

```sh
node evals/bookmarks/run.mjs --out evals/bookmarks/<date>-run.json
```

Without `OPENROUTER_API_KEY` it runs the lexical mode only. With
`TYPESAFE_API_KEY` as well it adds `jev`, production's hybrid: the lexical
top 50, then the bge-m3 top 50 it lacks, reranked by Jev through
`app/search/jev.ts`, the module `rerankedSearch` calls, with each candidate's
text built as it builds a source's. The eval waits 30 s for Jev where the
live search waits 1.5 s, so a slow call scores rather than falls back.

The index is node:sqlite FTS5 with the production tokenizer and weights, not
D1, and `hybrid` is rank fusion. Extracts are not
the Worker's HTMLRewriter cut, so passage boundaries differ a little from
production's.

## 2026-11-01

82 passages. Lexical, the question as asked: the right passage for 16 of
20 and the right bookmark for 19 of 20 in the top three. These pages share
more words with their questions than *On Liberty* did (12 of 20 lexical),
so this set leaves vectors less room. The misses are questions whose
answer uses a term the question avoids: hydrophily, a wind "jet", the
kuojtakiloyan, smoke and alarm pheromones.

## 2026-11-03

The same 82 passages and 20 questions with bge-m3 through OpenRouter, $0.0006
over 64k tokens. Top three, of 20:

| Mode | Right passage | Right bookmark |
| --- | --- | --- |
| lexical, the question as asked | 16 | 19 |
| bge-m3 cosine | 15 | 20 |
| reciprocal rank fusion of lexical and bge-m3 | 16 | 19 |

Vectors did not help these bookmarks the way they helped *On Liberty* (12
lexical, 18 fused). Cosine finds all four passages lexical misses
(hydrophily, the windbreak jet, the kuojtakiloyan, smoke) and loses five
lexical finds (hedge laying, the dehesa, Götsch, nasturtiums as a trap
crop, permaculture zones). Fusion keeps lexical's 16: it recovers
hydrophily and loses hedge laying. Cosine alone puts the right bookmark in
the top three for all 20.

Production's hybrid does not fuse ranks. It hands the union of the FTS and
bge-m3 top 50 to Jev (`app/search/rerank.ts`), so a passage only cosine
finds is still a candidate. Fusion is a stand-in for that rerank, and
without a TypeSafe key the eval cannot run Jev. `2026-11-03-run.json`
has every ranking.

## 2026-11-03, Jev

The same passages and questions with production's rerank,
`2026-11-03-jev-run.json`. Jev made 60 calls over 1.10M input tokens,
$0.046, median 323 ms per question; bge-m3 cost $0.0006 again. Top three,
of 20:

| Mode | Right passage | Right bookmark |
| --- | --- | --- |
| lexical, the question as asked | 16 | 19 |
| bge-m3 cosine | 15 | 20 |
| reciprocal rank fusion of lexical and bge-m3 | 16 | 19 |
| Jev over the lexical top 50 and the bge-m3 top 50 | 20 | 20 |

Jev finds every passage, including all four that lexical misses and the
five that cosine misses. The vectors are not why. With the OR fallback the
lexical top 50 covers 50 of the 82 passages, and every answer passage is in
it: the deepest is the smoke answer at lexical rank 15, the windbreak jet at
10. Jev reads text, so on a set this small it recovers paraphrases from the
lexical candidates alone, and the bge-m3 candidates add none it needed. This
set cannot show vectors helping bookmarks under production's rerank; that
takes a corpus where an answer passage falls outside the lexical top 50.
