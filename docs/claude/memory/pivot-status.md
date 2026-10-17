---
name: pivot-status
description: "Story/scope pivot state for PİLOT — Elif persona rejected, Kara Kutu shelved, ERC-8004 gate idea pending"
metadata:
  node_type: memory
  type: project
  originSessionId: 2bf2ac9d-d88c-42f0-8bf4-caf49def1315
  modified: 2026-10-17T13:56:48.100Z
---

State as of 2026-10-17 (hackathon day):
- The user rejected the "Elif saves TL as dollars" story as weak ("doğrudan dolar alsın"). He wants an agent that actively works with the money.
- **Kara Kutu (track record + learning) is shelved for now** at the user's request. The measurement workflow (kara-kutu-olcum, run wf_30bfb6b5-e7e) was stopped mid-run. It can be resumed from cache, and its data/scripts are in scratchpad/kk.
- Still open, not yet confirmed: agents that use KULE must hold an ERC-8004 identity ("tescil"); Uçuş Haritası cells; TRY/USDT/BTC positioning; sell direction. These conflict with SPEC §22 cut list and CLAUDE.md "Yapma", so they need team agreement (Barış, Bekir) before code changes.

**Why:** The scope is being reconsidered under time pressure.

**How to apply:** Do not build Kara Kutu or learning features unless the user revives them. Keep finishing the existing SPEC v4.1 code. Ask before any contract-interface change. Related: [[ui-owner-bekir]], [[kule-auth-binding]].
