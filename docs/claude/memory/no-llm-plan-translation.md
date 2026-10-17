---
name: no-llm-plan-translation
description: Decision on sentence→plan (planFromSentence) — LLM stays; user confirms/edits exact on-chain values in a confirmation popup before signing
metadata:
  node_type: memory
  type: project
  originSessionId: 2bf2ac9d-d88c-42f0-8bf4-caf49def1315
  modified: 2026-10-17T12:33:21.669Z
---

Final decision, 2026-10-17. This replaces an earlier "remove the LLM" idea. planFromSentence stays LLM-based as in SPEC §10.6. Safety comes from three layers:
1. zod validation.
2. enforceUserNumbers: no number may appear that is not in the sentence.
3. A confirmation popup, "Zincire yazılacak değerler", shown before signing. It lists the exact setPlan values with their source badge (senin cümlenden / varsayılan / senin düzeltmen). The user can edit a value, which re-validates it, and the wallet signature opens only from this popup.

A deterministic regex parser modelled on Koul was considered and dropped as unnecessary.

**Why:** The user wants number mistakes by the LLM to be visible to Elif and fixable by her. Removing the LLM was not the goal.

**How to apply:** One shared pure function in packages/shared turns the draft into setPlan args plus the popup rows. The popup and the signing call must use that same output. The popup UI itself belongs to Bekir ([[ui-owner-bekir]]), so its spec goes into docs/UI_HANDOFF.md §2.2.
