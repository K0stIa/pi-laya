# Decisions

Owner approved protected test update on 2026-09-24 to cover `/laya` registration.

path-protection-records@1
kind | paths | phase | date | authority | justification
justification | tests/extension.test.ts, tests/commands.test.ts | P1 | 2026-09-24 | execute-phase | Owner approved test updates for new /laya command and deterministic test configuration.
justification | tests/onnx-rounding.test.ts | P2 | 2026-09-24 | execute-phase | Owner approved correction of regression test for Minis ONNX four-decimal output.
justification | tests/inventory-skill-names.test.ts | P2 | 2026-09-24 | execute-phase | Keep Pi inventory ID prefix as existing contract and verify display normalization separately.
justification | tests/designer.test.ts | P2 | 2026-09-24 | execute-phase | User requested schema-constrained designer and one validation-guided retry; test requires correction for null-prototype validation output.
justification | tests/auto-routing-bounds.test.ts | P2 | 2026-09-24 | execute-phase | Live Pi automatic routing timed out on Minis with eight long candidates; bound count and size for CPU inference.
justification | tests/extension.test.ts | P3 | 2026-09-24 | execute-phase | Owner requested no-path active-session compaction beyond 20 removable entries; test complete grouping and protected context before implementation.
justification | tests/extension.test.ts | P4 | 2026-09-25 | execute-phase | Owner requested fix verified in real Pi; test thinking privacy and normal-session ONNX evaluation.
```
