export const meta = {
  name: 'kule-yetki-bagi',
  description: 'İddia edilen KULE yetki-bağı açığını doğrula; gerçekse shared içinde saf kontrol + testlerle kapat, incele',
  phases: [
    { title: 'Verify', detail: 'PoC, çürütme ve tehdit modeli — 3 bağımsız ajan' },
    { title: 'Fix', detail: 'packages/shared authz kontrolü + testler + .env.example' },
    { title: 'Review', detail: 'düzeltmeyi kırmaya çalış' },
    { title: 'Finalize', detail: 'doğrulanan bulguları uygula' },
  ],
}
const ROOT = '/Users/seyit/Desktop/idlo'
const COMMON = `Repo: ${ROOT}. docs/SPEC.md is the source of truth; CLAUDE.md rules apply. No state-changing git commands. No keys. Narrowest safe choice + TODO(spec) where SPEC is silent.
CLAIM under investigation: "If KULE only checks that a BuyAuthorized exists / is AUTHORIZED / the user's plan is active (SPEC §9.2 step 4), it can place an order on Elif's OKX account based on a plan Elif never signed — because setPlan (§8.2) lets ANY address create a plan for itself naming any agent, the real KULE, and any agentId." Contract: contracts/src/FlightPlan.sol, contracts/src/interfaces/IFlightPlan.sol. Shared: packages/shared (codes.ts has KULE verdict codes incl. NO_AUTHORIZATION or similar; tools/kule.ts has kule_execute schema). apps/kule is owned by another teammate (Bekir) and is mostly empty — do NOT implement KULE server code.`

const V = { type: 'object', properties: {
  verdict: { type: 'string', enum: ['CONFIRMED', 'REFUTED', 'PARTIAL'] },
  preconditions: { type: 'array', items: { type: 'string' } },
  evidence: { type: 'string' },
  spec_refs: { type: 'array', items: { type: 'string' } },
}, required: ['verdict', 'preconditions', 'evidence', 'spec_refs'] }

phase('Verify')
const verifs = await parallel([
  { k: 'poc', p: 'Write a Foundry test contracts/test/AuthBinding.t.sol that demonstrates the on-chain half: attacker address calls setPlan for itself naming (a) its own agent key and the real KULE address, and (b) the real PİLOT agent address; then requestBuy succeeds (BuyAuthorized emitted with attacker as user, kule field = real KULE) with limits far above Elif\'s plan. Run forge test. The test must PASS (it documents a contract property; name it e.g. "AUTH-BIND documents foreign plan ..."). Report exactly what an off-chain KULE that follows only §9.2 literally would accept.' },
  { k: 'refute', p: 'READ-ONLY. Try hard to REFUTE the claim from SPEC: read §9 entirely (esp. §9.2 every step, token→agent binding, "parametreleri zincirden okur"), §8.2–§8.4, §14 Mutabakat, §16 (all rows, esp. #19 agent key stolen), Ek B (kule .env: does any var pin the user/plan/Elif address?), CLAUDE.md rule 3 and 13. If any SPEC rule already forces KULE to check action.user == Elif (or equivalent), verdict REFUTED with the quote.' },
  { k: 'threat', p: 'READ-ONLY. Threat-model the claim realistically: what must the attacker hold (PİLOT agent private key? KULE bearer token? both?) — check §9 token→agent binding, §16 #19, and the §19 demo scene "ajan anahtarı çalındı". With only the agent key; with only a token; with both: can the attacker exceed Elif\'s signed limits on Elif\'s OKX account? Does Mutabakat (§14) detect it, and only after the fact? Conclude whether it breaks the product promise ("Ajanına anahtarını değil, imzalı talimatını ver").' },
].map(x => () => agent(`${COMMON}\n${x.p}`, { label: `doğrula:${x.k}`, phase: 'Verify', schema: V })))
const vs = verifs.filter(Boolean)
const confirmed = vs.filter(v => v.verdict !== 'REFUTED').length >= 2
log(`Doğrulama: ${vs.map(v => v.verdict).join(', ')} → ${confirmed ? 'AÇIK GERÇEK' : 'AÇIK DEĞİL'}`)
if (!confirmed) return { confirmed: false, verifs: vs }

phase('Fix')
const fix = await agent(`${COMMON}
The claim was verified. Verifier outputs:\n${JSON.stringify(vs, null, 2)}
Implement the off-chain binding check WITHOUT touching apps/kule source (Bekir owns it) and WITHOUT changing FlightPlan.sol logic:
1. packages/shared/authz.ts: a pure function (e.g. checkActionBinding) taking the on-chain action (as read from chain: id, user, amountTL, state, openBy/reportBy...), the on-chain plan of action.user (agent, kule, agentId, active/revoked/expiry), and KULE config {planUser (Elif address), kuleReporter (KULE's own address), tokenAgent (agent address bound to the calling bearer token), agentId?}. Returns ok or a reject with the right §9.2 verdict/code from codes.ts (reuse existing NO_AUTHORIZATION-type code; do not invent new names unless unavoidable → TODO(spec)). Address comparison case-insensitive via viem getAddress/isAddressEqual; invalid/zero addresses → reject (fail-closed). Also check openBy not passed (TOO_LATE) only if that already exists in codes; otherwise leave to KULE.
2. Export from packages/shared/index.ts. Tests packages/shared/test/authz.test.ts named "U-4 ..." covering: Elif's genuine action passes; foreign user's plan naming real KULE+agent → reject; plan.kule != kuleReporter → reject; plan.agent != tokenAgent → reject; checksum/lowercase equivalence passes; zero/malformed config → reject; revoked/expired plan → reject.
3. apps/kule/.env.example: add ELIF_USER_ADDRESS= (empty, Turkish comment explaining: KULE yalnız bu adresin planına bağlı izinleri uygular). This one-line env addition is allowed.
4. Keep contracts/test/AuthBinding.t.sol from the PoC as documentation (rename tests if needed so they read as a documented property, not a failing bug).
5. Update the TODO(spec) natspec on BuyAuthorized in IFlightPlan.sol to point to packages/shared/authz.ts (comment only).
Run pnpm --filter @pilot/shared build && pnpm --filter @pilot/shared test, pnpm -r build, and cd contracts && forge test. All must pass. Return a concise report.`, { label: 'düzelt:authz', phase: 'Fix' })

phase('Review')
const F = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'major', 'minor'] }, issue: { type: 'string' }, fix: { type: 'string' } }, required: ['file', 'severity', 'issue', 'fix'] } } }, required: ['findings'] }
const reviews = await parallel([
  'ADVERSARY: try to bypass packages/shared/authz.ts — address case/checksum tricks, zero address, plan replaced via commitPending after authorization, revoked plan, action of a different user with same agent, missing fields, type confusion (bigint vs number agentId). Write extra failing tests in a scratch file under packages/shared/test/authz.adversarial.test.ts; keep the ones that reveal real bypasses and report them.',
  'READ-ONLY SPEC reviewer: does authz.ts + tests match §9.2 (order of checks, verdict codes, Turkish messages), CLAUDE.md rule 3 (params read from chain, not caller) and rule 2 (fail-closed)? Is anything over-engineered beyond what is needed? Is the .env.example change consistent with Ek B naming style?',
].map((p, i) => () => agent(`${COMMON}\nFix report:\n${fix}\n\n${p}\nOnly concrete defects.`, { label: `incele:${i + 1}`, phase: 'Review', schema: F })))
const findings = reviews.filter(Boolean).flatMap(r => r.findings)
log(`İnceleme: ${findings.length} bulgu`)

phase('Finalize')
let fin = 'no findings'
if (findings.length) {
  fin = await agent(`${COMMON}\nVerify each finding against code/SPEC; fix only the real ones surgically (skip false ones and say why). Then run pnpm --filter @pilot/shared test, pnpm -r build, cd contracts && forge test — all must pass.\nFindings:\n${JSON.stringify(findings, null, 2)}\nFix report:\n${fix}\nReturn: applied, skipped (why), final test counts.`, { label: 'son düzeltme', phase: 'Finalize' })
}
return { confirmed: true, verifs: vs, fix, findings, fin }
