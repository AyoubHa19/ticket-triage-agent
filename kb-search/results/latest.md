Knowledge base: 30 chunks from 9 documents.

Queries: 27 answerable, 7 with no answer in the knowledge base.

| Retriever | Hit@1 | Hit@3 | MRR@5 | Relevance AUC |
|---|---|---|---|---|
| bm25 | 81.5% | 88.9% | 0.861 | 0.91 |
| vector | 85.2% | 92.6% | 0.889 | 0.90 |
| hybrid | 81.5% | 92.6% | 0.870 | 0.90 |

Refusal sweep (a query is refused when its best hit's relevance is below the threshold):

| Retriever | Threshold | Correctly refused (unanswerable) | Wrongly refused (answerable) |
|---|---|---|---|
| bm25 | 0.15 | 2/7 | 2/27 |
| bm25 | 0.20 | 4/7 | 3/27 |
| bm25 | 0.25 | 5/7 | 3/27 |
| bm25 | 0.30 | 7/7 | 3/27 |
| bm25 | 0.35 | 7/7 | 3/27 |
| bm25 | 0.40 | 7/7 | 6/27 |
| vector | 0.15 | 2/7 | 2/27 |
| vector | 0.20 | 4/7 | 3/27 |
| vector | 0.25 | 5/7 | 3/27 |
| vector | 0.30 | 7/7 | 3/27 |
| vector | 0.35 | 7/7 | 3/27 |
| vector | 0.40 | 7/7 | 6/27 |
| hybrid | 0.15 | 2/7 | 2/27 |
| hybrid | 0.20 | 4/7 | 3/27 |
| hybrid | 0.25 | 5/7 | 3/27 |
| hybrid | 0.30 | 7/7 | 3/27 |
| hybrid | 0.35 | 7/7 | 3/27 |
| hybrid | 0.40 | 7/7 | 6/27 |

### bm25: answerable queries not ranked first
- q07 "When will I get my service charge statement?" -> expected service-charges > When the statement is sent (rank 2), got service-charges > Objections to the statement
- q10 "How do I sort my rubbish correctly?" -> expected waste > Separating waste (rank >5), got (no results)
- q11 "Where can I get rid of my old sofa?" -> expected waste > Bulky waste (rank >5), got (no results)
- q12 "When is the organic waste collected?" -> expected waste > Collection days (rank 2), got waste > Separating waste
- q26 "What do I need to do when I move out?" -> expected moving-out > Handover (rank 4), got moving-out > Forwarding address

### vector: answerable queries not ranked first
- q10 "How do I sort my rubbish correctly?" -> expected waste > Separating waste (rank >5), got house-rules > Pets
- q11 "Where can I get rid of my old sofa?" -> expected waste > Bulky waste (rank >5), got house-rules > Balconies and barbecues
- q20 "Can I keep a dog?" -> expected house-rules > Pets (rank 2), got heating > Maintenance appointments
- q26 "What do I need to do when I move out?" -> expected moving-out > Handover (rank 2), got damage > Mould

### hybrid: answerable queries not ranked first
- q10 "How do I sort my rubbish correctly?" -> expected waste > Separating waste (rank >5), got house-rules > Pets
- q11 "Where can I get rid of my old sofa?" -> expected waste > Bulky waste (rank >5), got house-rules > Balconies and barbecues
- q12 "When is the organic waste collected?" -> expected waste > Collection days (rank 2), got waste > Separating waste
- q20 "Can I keep a dog?" -> expected house-rules > Pets (rank 2), got heating > Maintenance appointments
- q26 "What do I need to do when I move out?" -> expected moving-out > Handover (rank 2), got damage > Mould
