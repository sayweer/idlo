---
name: orchestrator-only
description: In the PİLOT (idlo) project the main chat agent only manages; all coding is done by subagents/workflows
metadata:
  node_type: memory
  type: feedback
  originSessionId: 2bf2ac9d-d88c-42f0-8bf4-caf49def1315
  modified: 2026-10-17T10:49:33.663Z
---

In this project the main chat agent stays idle as a manager: it plans, launches subagents/workflows, and reports. Subagents write the code. User and main agent "manage together" from the chat.

**Why:** User asked explicitly on 2026-10-17 at project start ("bu chat ekranındaki agent boş dursun ve alt ajanlara işleri yaptırsın").

**How to apply:** Only do light inline scouting (ls, headings, small reads to write good prompts). Delegate implementation, testing and review to workflows. After each task, report a short summary and get the user's approval before the next one, unless they pre-approved a chain (e.g. Görev 1 → 2+3 in parallel was pre-approved).
