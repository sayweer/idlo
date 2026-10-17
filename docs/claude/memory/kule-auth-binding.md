---
name: kule-auth-binding
description: "Verified security gap — KULE must bind BuyAuthorized to Elif's plan; fix lives in packages/shared/authz.ts but KULE wiring is still pending (Bekir)"
metadata:
  node_type: memory
  type: project
  originSessionId: 2bf2ac9d-d88c-42f0-8bf4-caf49def1315
  modified: 2026-10-17T11:57:14.929Z
---

Gap verified by 3 independent checks plus a Foundry PoC on 2026-10-17. FlightPlan.setPlan lets any address create a plan for itself that names the real PİLOT agent, the real KULE and agentId. A KULE that applies SPEC §9.2 step 4 literally ("BuyAuthorized exists + plan active") would then place an order on Elif's OKX account from a plan Elif never signed. Realistic precondition: the agent key plus PILOT_TOKEN are stolen. Both sit in apps/pilot/.env. This breaks the §10.5/§19 "ajan anahtarı çalındı" promise.

Fix (commit 4ae58d1): packages/shared/authz.ts adds `checkActionOwner`, called before the step-2 lock, and `checkActionLive`, called after step-3 health. apps/kule/.env.example gets PLAN_USER_ADDRESS and PILOT_AGENT_ADDRESS. CLAUDE.md rule 3 is extended. The contract is unchanged on purpose.

**Why:** The protection works only once KULE (Bekir, Görev 4) calls these checks in kule_execute.

**How to apply:** When KULE work starts or is reviewed, verify the two calls are wired in the right order and that U-4/AUTH-BIND tests exist at the KULE level. Open TODO(spec): KULE should reject any BuyAuthorized older than the user's latest PlanSet/PlanRevoked, because anyone can call commitPending. SPEC §9.2 and Ek B were not edited; the team should update SPEC. Related: [[ui-owner-bekir]].
