# kb-search

Retrieval over a company knowledge base, built the way an agent needs it: **find the right section, and know
when nothing relevant exists.**

```
markdown docs -> heading-aware chunks -> BM25 index          \
                                      -> hashing embeddings   >-> rank fusion (RRF) -> hits + relevance
query ---------> same tokenisation  ------------------------/
                                                          -> agent tool: results, or "no answer, do not guess"
```

## What is in it

- **Chunking** (`chunk.ts`): one chunk per `##`/`###` section, long sections split on paragraph boundaries with one
  paragraph of overlap. Title and heading are part of the indexed text, so a section is findable by its name.
- **BM25** (`bm25.ts`): implemented from scratch, with accent folding, English stopwords and a light suffix
  stripper. Also computes IDF-weighted *query coverage*, a bounded signal used for refusal decisions.
- **Hashing embedder** (`embed.ts`): dependency-free signed feature hashing of words and character trigrams,
  IDF-weighted from the corpus. Tests show it places a compound ("doorbell") near its parts and tolerates a small
  typo ("radaitor" still finds the radiator section), which whole-word BM25 cannot. **It is not a semantic model**
  (it does not know that a sofa is bulky waste, or that rubbish means waste). Implement the `Embedder` interface
  with a hosted embedding model for that; nothing else changes (there is a test with a custom embedder).
- **Reciprocal rank fusion** (`index.ts`): combines the two rankings without aligning their score scales.
- **Relevance** (`index.ts`): rank fusion gives an order but not an answer to "is the best hit any good?", so each hit
  also carries an absolute relevance in [0, 1]. The agent uses it to refuse instead of answering from weak matches.
- **Agent tool** (`tool.ts`): JSON-Schema input, returns cited results, returns an explicit "do not answer from
  general knowledge" note and no snippets when nothing relevant exists, and reports bad input as data instead of
  throwing so the model can correct itself.

## Results (real run, `node src/run-eval.ts`)

9 sample documents, 30 chunks, 27 answerable queries and 7 the knowledge base cannot answer.

| Retriever | Hit@1 | Hit@3 | MRR@5 | Relevance AUC |
|---|---|---|---|---|
| bm25 | 81.5% | 88.9% | 0.861 | 0.91 |
| vector (hashing) | 85.2% | 92.6% | 0.889 | 0.90 |
| hybrid | 81.5% | 92.6% | 0.870 | 0.90 |

What this does and does not show:

- Whole-word BM25 is the weakest on hit@3. It fails on typos ("radaitor" returns nothing from BM25, while the
  n-gram vectors still find "Radiator not getting warm") and on near-ties between sections of one document
  (`q07` is ranked second by BM25 and first by hybrid).
- **Hybrid is not better than vector alone here.** Vector has the best hit@1 and MRR and ties on hit@3 and AUC. The
  hit@1 gap is a single query (23 vs 22 of 27), so treat it as noise. Fusion should pay off more when the two
  retrievers are strong in different ways; re-run this eval with a real embedding model before drawing conclusions.
- Failures shared by every mode: `q10` ("sort my rubbish" while the section says "waste") and `q11` ("old sofa" needs the
  concept "bulky waste"). These need semantics, not subwords. `q26` ("what do I need to do when I move out?") is ranked
  2nd to 4th because every section of the moving-out document matches it about equally.
- **Refusal looks clean on this set, and that should not be over-read.** A relevance threshold of 0.30 refuses all 7
  unanswerable queries and wrongly refuses 3 of 27 answerable ones (`q10`, `q11`, `q16`), in every mode. But the
  closest unanswerable queries ("Can I sublet my flat?", "Which internet providers...?") score 0.27, just under the
  threshold, and both sets were written by hand (full sweep in `results/latest.md`). That is why the inbox agent also
  requires the drafting step to cite excerpts. The threshold in `integration.test.ts` is read off this sweep and is not
  a validated operating point.

## Run

```bash
node --test "src/**/*.test.ts"   # 48 tests, no install needed
node src/run-eval.ts             # prints and writes results/latest.md
```

## Limitations

- The documents and the queries were both written by hand for this project, so retrieval looks easier than it will on
  real customer content. With 27 answerable queries, one query is 3.7 points.
- The sample knowledge base is illustrative content, not legal advice.
- The stemmer is a suffix stripper, not Porter or Snowball.
- Chunks are rebuilt from scratch on every start; there is no incremental indexing or persistence. In Convex, store chunks
  and embeddings in a table with a vector index and keep this retrieval logic as the ranking layer.
