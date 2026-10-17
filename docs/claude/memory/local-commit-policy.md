---
name: local-commit-policy
description: PİLOT repo — commit locally after every meaningful change with team co-author trailers; never push
metadata:
  node_type: memory
  type: feedback
  originSessionId: 2bf2ac9d-d88c-42f0-8bf4-caf49def1315
  modified: 2026-10-17T11:20:34.696Z
---

In the PİLOT (idlo) repo, the user gave standing permission (2026-10-17) to commit **locally** after every meaningful change. Push is not included.

Commit identity: the author is the repo's default git user (sayweer <degirmenseyit@gmail.com>). Every commit ends with these trailers:
```
Co-authored-by: Barış <barisyzici@gmail.com>
Co-authored-by: Bekir Erdem <62079983+bekirerdem@users.noreply.github.com>
```
Bekir's address is the GitHub noreply form built from public API id 62079983 (github.com/bekirerdem).

NEVER add Claude attribution (Co-Authored-By Claude, Claude-Session, 🤖 lines). The global CLAUDE.md rule still applies.

**Why:** The user wants the whole team to show as contributors and Claude to show in none.

**How to apply:** The main agent commits after each workflow finishes. Workflow subagents do not commit, because parallel commits would conflict. Split each workflow's output into logical conventional commits by path. Related: [[orchestrator-only]].
