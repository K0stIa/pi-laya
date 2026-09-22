# pi-laya Implementation Plan

**Goal:** Deliver a Pi extension with a generic Laya transport and safe typed
decision tools, then add advisory policy modules for the seven System-One
placements.

1. Create the package, configuration, schemas, and privacy scan; test that an
   unconfigured package loads without network activity.
2. Implement an authenticated Laya client with response validation, bounded
   requests, deadlines, queueing, and loopback HTTP tests.
3. Register `laya_evaluate` and opt-in `laya_system_one`; test Pi loader and
   collision behavior.
4. Implement pure proposal policies for skill/tool selection, model routing,
   retention, action candidates, supervision, and review risks. Test each
   policy's thresholds, abstention, and bounded inputs.
5. Add commands, opt-in hooks, and adapters only where a compatible public Pi
   API is verified. Browser, computer, and subagent integrations remain
   proposal-only until their contracts have dedicated tests.
6. Run typecheck, unit/integration tests, package smoke test, privacy scan,
   and an explicitly configured synthetic live test before release.

**Constraints:** no private deployment data; no default URL; no hosted decision
SDK; no model weights; at most 20 questions per request; all automation off by
default; Laya never generates text; automatic side effects require complete
evidence and an explicit compatible adapter.
