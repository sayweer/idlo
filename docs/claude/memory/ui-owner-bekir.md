---
name: ui-owner-bekir
description: PİLOT web UI (apps/web) belongs to Bekir; agents must not build UI here
metadata:
  node_type: memory
  type: project
  originSessionId: 2bf2ac9d-d88c-42f0-8bf4-caf49def1315
  modified: 2026-10-17T11:28:58.429Z
---

As of 2026-10-17, Bekir builds the UI side (apps/web, SPEC §13). He will pull the repo and do it himself.

**Why:** The user split the work within the team.

**How to apply:** Do not plan or launch UI or frontend work in workflows. Keep the current apps/web Next.js skeleton as it is. Backend parts the UI will consume can still be built: shared schemas, API/MCP contracts, deployments/fuji.json. Keep those stable and documented so Bekir can use them. When the subject comes up, ask before touching apps/web. Related: [[local-commit-policy]], [[orchestrator-only]].
