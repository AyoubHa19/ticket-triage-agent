Dataset: 37 tickets (17 should be escalated, 20 should not).

| System | Category acc. | Escalation recall | Escalation precision | F1 | Missed escalations | Unnecessary escalations | Errors | p50 ms | p95 ms | $/1k tickets |
|---|---|---|---|---|---|---|---|---|---|---|
| policy-only (no LLM) | 86.5% | 70.6% | 92.3% | 0.80 | 5/17 | 1/20 | 0 | 0 | 1 | $0.00 |

### policy-only (no LLM)
Missed escalations (needed a human, handled automatically):
  - t02: Pipe burst
  - t08: Mould in the bedroom
  - t11: Service charge statement wrong
  - t15: Stairwell
  - t16: Roof renovation
Unnecessary escalations (handed to a human although routine):
  - t25: Smoke detector beeping
