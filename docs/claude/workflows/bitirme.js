export const meta = {
  name: 'bitirme',
  description: 'Bizim tarafı bitir: npm kütüphaneler + hava→shared, A3, A4, C7, C8, onay penceresi, yerel E1 uçtan uca; kır, incele, düzelt',
  phases: [
    { title: 'Prep', detail: 'kontrat kütüphaneleri npm, hava hesaplayıcısı shared, birim düzeltmeleri' },
    { title: 'Implement', detail: '5 hat paralel' },
    { title: 'Break', detail: 'saldırgan testler' },
    { title: 'Review', detail: 'SPEC + güvenlik' },
    { title: 'Verify', detail: 'bulguları çürüt' },
    { title: 'Fix', detail: 'doğrulananları uygula' },
    { title: 'E2E', detail: 'anvil üzerinde uçtan uca (E1 yerel)' },
    { title: 'Integrate', detail: 'tüm repo build + test + gizli anahtar taraması' },
  ],
}
const ROOT = '/Users/seyit/Desktop/idlo'
const COMMON = `Repo: ${ROOT}. docs/SPEC.md is the source of truth; CLAUDE.md rules apply (esp. 1,2,3,4,5,6,7,10,11,12). Committed so far: packages/shared (units, schemas, codes, tool schemas, deployments.ts, authz.ts), contracts (FlightPlan + Deploy.s.sol, 118 tests), apps/pilot (weather, rules=kural_danis, plan=planFromSentence (LLM, stays), tools, clients incl. FakeKule + MCP KuleClient, loop + trace + rule mode), scripts/make-replay.ts, data/replays, docs/DEPLOY.md, docs/UI_HANDOFF.md.
apps/kule and apps/web belong to teammate Bekir — never write code there (only docs/UI_HANDOFF.md may describe UI).
No state-changing git commands. NEVER write keys (anvil test keys only via shell env, never in files). Never broadcast to a real network. No withdrawal code.
SPEC silent → narrowest safe choice + "TODO(spec): ..." comment. Tests named with SPEC §18 ids.
Do not edit packages/shared/index.ts unless your ownership says so.`

const REPORT = { type: 'object', properties: {
  tests_pass: { type: 'boolean' }, test_summary: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
  notes: { type: 'string' }, todo_spec: { type: 'array', items: { type: 'string' } }, user_actions: { type: 'array', items: { type: 'string' } },
}, required: ['tests_pass', 'test_summary', 'files', 'notes', 'todo_spec', 'user_actions'] }
const FINDINGS = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: {
  file: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'major', 'minor'] }, spec_ref: { type: 'string' }, issue: { type: 'string' }, suggested_fix: { type: 'string' } },
  required: ['file', 'severity', 'spec_ref', 'issue', 'suggested_fix'] } } }, required: ['findings'] }
const VERDICT = { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] }

async function harden(key, owns, impl, breakP, lenses, testCmd) {
  const brk = await agent(`${COMMON}\nYou own (add tests only): ${owns}\nImplementation report:\n${impl}\n\n${breakP}\nKeep passing adversarial tests. For failures revealing real bugs: keep test, report precisely, do NOT fix code. Fix/delete tests that misread SPEC.`, { label: `kır:${key}`, phase: 'Break' })
  const revs = await parallel(lenses.map((l, i) => () => agent(`${COMMON}\nREAD-ONLY reviewer. Track ${key}. Lens: ${l}\nImpl:\n${impl}\nAdversary:\n${brk}\nInclude adversary's real bugs. Concrete defects only, SPEC refs.`, { label: `incele:${key}:${i + 1}`, phase: 'Review', schema: FINDINGS })))
  const fs = revs.filter(Boolean).flatMap(r => r.findings)
  const judged = (await parallel(fs.map(f => () => agent(`${COMMON}\nREAD-ONLY. Try to REFUTE against code + docs/SPEC.md (may run tests). Not required or already satisfied → real=false. Uncertain → real=false.\nFinding: ${JSON.stringify(f)}`, { label: `doğrula:${key}`, phase: 'Verify', schema: VERDICT }).then(v => ({ ...f, verdict: v }))))).filter(Boolean)
  const conf = judged.filter(f => f.verdict.real)
  log(`${key}: ${judged.length} bulgu, ${conf.length} doğrulandı`)
  const fin = await agent(`${COMMON}\nYou own: ${owns}\nApply verified findings surgically; make all adversarial tests pass by fixing code. Run ${testCmd} and pnpm -r build.\nFindings:\n${JSON.stringify(conf.map(({ verdict, ...f }) => f), null, 2)}\nAdversary:\n${brk}\nImpl:\n${impl}`, { label: `düzelt:${key}`, phase: 'Fix', schema: REPORT })
  return { key, final: fin, confirmed: conf.map(f => ({ severity: f.severity, file: f.file, issue: f.issue })), rejected: judged.length - conf.length }
}

phase('Prep')
const prep = await agent(`${COMMON}\nYou own for this step: contracts/ (deps/remappings/foundry.toml/package.json only), root package.json/pnpm-workspace.yaml/.gitignore, packages/shared (new weather module + index.ts), apps/pilot (imports + inline unit fixes), apps/servis/package.json.
Three prep tasks, in order, keeping ALL existing tests green after each:
1. Contract deps reproducible for teammates: today contracts/lib (OZ, solady, forge-std) is gitignored so a fresh clone cannot forge build. Switch to npm via the pnpm workspace: make contracts a workspace package (contracts/package.json, private) with exact pinned versions matching what is installed now (OpenZeppelin 5.x version in lib, solady version, forge-std via its npm/github package), update remappings (remappings.txt/foundry.toml libs) to node_modules, remove the lib/ dependency, verify a clean \`pnpm install\` + \`forge build\` + \`forge test\` passes (simulate clean: move contracts/lib aside to the scratchpad, never delete without moving). Document in contracts/README.md. Keep forge-std compatible with Foundry 1.7.
2. Move the pure Lira Hava Durumu calculator from apps/pilot/src/weather into packages/shared/weather/ (no node:fs inside shared; replay file READING stays in apps/pilot) so apps/servis can reuse it; export from packages/shared/index.ts; update apps/pilot imports; weather tests keep passing (they may stay in apps/pilot importing from @pilot/shared or move to shared).
3. CLAUDE.md rule 7: replace inline time conversions with units.ts helpers (add helpers there if missing, with tests): apps/pilot/src/clients/fakeKule.ts ((nowMs - x)/1000), apps/pilot/src/tools/pilotTools.ts (24*3600*1000), apps/pilot/src/loop/replay.ts (expiresInDays * 86_400); grep apps/pilot/src and packages/shared for any other inline sec/ms/hour/day math and fix.
Run pnpm install, pnpm -r build, pnpm -r test, cd contracts && forge test.`, { label: 'hazırlık', phase: 'Prep', schema: REPORT })

const TRACKS = [
  { key: 'A3', owns: 'scripts/register-agent.ts, scripts/lib/** (shared script helpers you create), scripts/test/** or scripts/*.test.ts, scripts/package.json if needed, data/agent-card/** (the agent.json content), docs/DEPLOY.md (append A3 section only)',
    impl: `TASK A3 (§8.5, §17.2 A3, Ek B ERC-8004 Fuji addresses, UI_HANDOFF §2.6 /agent.json): scripts/register-agent.ts — registers PİLOT in the official ERC-8004 Identity registry on Fuji via viem (register with the agent card URI), reads agentId from the event/receipt, writes agentId into deployments/fuji.json via the shared deployments schema (fail-closed: refuse if fuji.json missing/invalid, refuse non-43113 unless --local, refuse if already registered unless --force). Generate the agent card JSON (ERC-8004 registration file format per SPEC/§8.5; [DOĞRULA] fields) as data/agent-card/agent.json template + a pure builder function the web can import later (put it in scripts/lib, NOT in apps/web). ABI: minimal, only functions SPEC/§21 #5 confirm (register, giveFeedback) — mark unverified ones [DOĞRULA]. Tests with a fake/anvil registry contract (you may deploy a tiny mock registry in tests; don't touch contracts/src). Commands for the user in user_actions + DEPLOY.md section.`,
    breakP: 'ADVERSARY: wrong chain, missing/invalid fuji.json, double registration, agentId parsing from wrong event/log of another contract, overwriting other fields of fuji.json, key leaks in logs.',
    lenses: ['SPEC fidelity §8.5/§17.2 A3/Ek B and UI_HANDOFF §2.6 needs.', 'Security/fail-closed: no keys in files/logs, chain guard, deployments write is atomic and schema-validated.'],
    test: 'pnpm -r test' },
  { key: 'A4', owns: 'scripts/stolen-key.ts, scripts/mutabakat.ts, scripts/lib/okx-readonly.ts and related scripts/lib/** files (coordinate: do not edit files A3 creates; prefix yours with mutabakat-/stolen-), their tests',
    impl: `TASK A4 (§10.5 'ajan anahtarı çalındı', §14 Mutabakat, §16, §18 E-4 + M-1, §19 scene timing): (1) scripts/stolen-key.ts: with the PİLOT agent key (env only) attempts an out-of-plan requestBuy for Elif and shows BuyRejected on chain with Snowtrace link; must work against anvil (--local) and Fuji; clearly prints Turkish scene text. Also include the foreign-plan variant from contracts/test/AuthBinding.t.sol to show KULE's authz (packages/shared authz.ts) refuses it (offline check using authz functions). (2) scripts/mutabakat.ts: runs on Elif's machine with HER read-only OKX key (env, never Trade): reads OKX TR filled/open orders for USDT-TRY in a window (read-only REST, signed per OKX v5 auth — implement minimal HMAC signing, no withdrawal/trade endpoints, hard allow-list of GET paths) and chain events (BuyAuthorized, ExecutionReported...) via viem getLogs in chunks from deployBlock; matches by clOrdId/tag/actionId per §14; prints EŞLEŞTİ / ALARM table in Turkish; exit code non-zero on ALARM. Inject OKX + chain clients for tests. Tests E-4, M-1 (+ M-* if §18 has more).`,
    breakP: 'ADVERSARY: mutabakat — exchange order with no chain auth (must ALARM), chain auth with no exchange order, amount mismatch, duplicate clOrdId, pagination gaps, clock/timezone (UTC+3, ms vs s via units.ts), read-only key accidentally allowed to call a trade/withdraw path (must be impossible). stolen-key — must never succeed in buying; works when plan missing.',
    lenses: ['SPEC fidelity §10.5/§14/§18 E-4,M-1/§19.', 'Security: OKX client hard-restricted to read-only GET allow-list, no keys in output/logs, fail-closed on partial data (never print EŞLEŞTİ when data incomplete).'],
    test: 'pnpm -r test' },
  { key: 'C7', owns: 'apps/pilot/src/tools/** (only news/calendar tool files + their registration), apps/pilot/src/news/**, apps/pilot/src/calendar/**, data/demo/**, apps/pilot/test/news*.test.ts, apps/pilot/test/calendar*.test.ts, apps/pilot/test/scene*.test.ts',
    impl: `TASK C7 (§10.2 haberleri_oku + ekonomik_takvim, §10.3, §10.5 injection demo, §19 scenes, §21 #10, §18 E-3 + E-5): demo news item with a hidden instruction (INJECTION_DEMO flag, clearly labelled, never disables guards) — show that even if the LLM obeys it, contract/KULE stop it; ekonomik_takvim tool: ATK news_get_economic_calendar is [DOĞRULA] so implement an interface with (a) ATK-backed adapter stub marked TODO and (b) a labelled demo calendar from data/demo; the "önerilenden farklı seçim" scene: LLM sees a calendar event and picks an allowed option different from kural_danis's recommendation with a Turkish rationale — trace must record recommended vs chosen (chosenOptionId) so UI can badge it (see docs/UI_HANDOFF.md /panel). Tests E-3, E-5 with fake LLM scripted to reproduce both scenes deterministically.`,
    breakP: 'ADVERSARY: injection text variants (Turkish/English/unicode tricks) trying to raise amount, change user, call non-§10.2 tools, or make rule mode act; calendar data malformed/stale; "different choice" must still be inside allowed options — try to make it choose a disallowed option.',
    lenses: ['SPEC fidelity §10.2/§10.3/§10.5/§19/E-3,E-5; trace fields the UI needs.', 'Security: untrusted text never reaches system prompt as instructions, demo flags labelled and never weaken guards, choice always within kural_danis allowed set.'],
    test: 'pnpm --filter pilot test' },
  { key: 'C8', owns: 'apps/servis/** (incl. .env.example empty fields only)',
    impl: `TASK C8 (§12 OKX.AI services, keyless, port 8790, CLAUDE.md rule 6; §18 S-1..S-3; §20 TCMB note): apps/servis as a Streamable HTTP MCP server (@modelcontextprotocol/sdk) bound to 127.0.0.1:8790 with two tools: (1) Emir Denetimi (free): checks an order draft (shared schemas; sz unit trap market vs limit per CLAUDE.md rule 9, tickSz rounding, limits) and returns verdict + Turkish reasons — pure, no keys; (2) Lira Hava Durumu (paid, x402 representational): uses the shared weather calculator on PUBLIC OKX candles (no key), returns Weather + "veridir, tavsiye değildir"; 402 flow representational: without a payment proof header returns a 402-style payment requirement, with MOCK_OKX_FACILITATOR (clearly labelled in output) accepts a mock proof; real x402 mode TODO(spec)/[DOĞRULA] (§21 #6). Holds NO keys. Tests S-1..S-3 with fetch mocked for OKX public data.`,
    breakP: 'ADVERSARY: servis must not hold/accept keys; try to get paid tool for free (header tricks, replayed mock proof, mock mode off), malformed order drafts, sz unit trap cases, huge inputs, binding to 0.0.0.0, OKX public API errors → fail-closed.',
    lenses: ['SPEC fidelity §12/S-1..S-3/rule 6/rule 9.', 'Security: keyless, localhost bind, payment check not bypassable, MOCK mode labelled, no tavsiye language.'],
    test: 'pnpm --filter servis test' },
  { key: 'ONAY', owns: 'packages/shared/plan/** (new), packages/shared/index.ts (export lines for your module only), packages/shared/test/confirm*.test.ts, docs/UI_HANDOFF.md (§2.2 and §3.1 only)',
    impl: `TASK: plan confirmation popup support (team decision): planFromSentence stays LLM-based; before signing, the user sees a popup "Zincire yazılacak değerler" listing exactly the setPlan values and can correct them. Implement ONE pure function in packages/shared/plan/ (e.g. buildPlanConfirmation(draft, ctx) → { setPlanArgs (exact IFlightPlan.setPlan args/types), rows: [{field, labelTr, displayTr (formatted via units.ts, Turkish number format), chainValue (string), source: 'user'|'default'|'edited', editable, note}], signable, blockers[] }) and applyEdit(confirmation, field, value) → re-validated confirmation (zod + same validation rules as FlightPlan._validate/InvalidPlan narrowest rules + §8.2 tightening preview: will this be immediate or wait 24h vs the current on-chain plan). Both popup display and the signing call MUST use setPlanArgs from this function (single source). Edited fields get source 'edited' (badge "senin düzeltmen"). Existing helpers (draftToPlan etc.) — reuse, don't duplicate; if draftToPlan exists, build on it. Tests: Elif §1 sentence draft and §19 demo plan (300/150/15/25) rows + args; edits; invalid edit blocks signing; 24h prediction. Then update docs/UI_HANDOFF.md §2.2 (popup spec: rows, badges, edit flow, sign only from popup, error states) and §3.1 (new exports).`,
    breakP: 'ADVERSARY: make the popup show one value while setPlanArgs carries another; edits with non-integer TL, negative, huge, day 29-31, deadline<start, maxOrder>cycle; unit/format confusion (Turkish 20.000 vs 20,000); agent/kule/agentId editable (must be locked); 24h prediction wrong vs FlightPlan._isTighterOrEqual (compare with the Solidity logic).',
    lenses: ['Correctness vs IFlightPlan.setPlan types and FlightPlan._validate/_isTighterOrEqual (read Solidity), SPEC §8.2/§10.6/§13/§15.', 'UX-safety: single source of truth for display + signing, fail-closed blockers, Turkish texts, UI_HANDOFF accuracy.'],
    test: 'pnpm --filter @pilot/shared test' },
]

phase('Implement')
const results = await pipeline(TRACKS,
  t => agent(`${COMMON}\nPrep step report (already done):\n${JSON.stringify(prep)}\nYou own: ${t.owns}\n${t.impl}\nRun ${t.test} and pnpm -r build until green.`, { label: `yaz:${t.key}`, phase: 'Implement', schema: REPORT }),
  (impl, t) => harden(t.key, t.owns, JSON.stringify(impl), t.breakP, t.lenses, t.test))

phase('E2E')
const e2e = await agent(`${COMMON}\nYou own: scripts/e2e.ts, scripts/e2e/** and its test/docs (append an E2E section to docs/DEPLOY.md).
TASK E1-local (§17.2 E1, §19): scripts/e2e.ts runs the whole flow on a local anvil (chain id 43113 fork-free local mode allowed via flags already in Deploy.s.sol; anvil test keys ONLY via shell env): deploy FlightPlan → Elif setPlan (demo plan 300/150/15/25 or as SPEC E1 says) → PİLOT loop in rule mode (and LLM mode if ANTHROPIC_API_KEY set) over replay 2025-03-19 with simulated clock → izin_iste hits anvil requestBuy → a test-only KULE stand-in (inside scripts/e2e, NOT apps/kule) that applies packages/shared authz checks and calls reportExecution as the KULE reporter with a paper fill → mutabakat (scripts/mutabakat.ts logic) with matching fake exchange orders prints EŞLEŞTİ; also the stolen-key scene against the same chain shows BuyRejected. Run it for real (start anvil in background on a free port, kill it after). Make it a single command documented in DEPLOY.md. Report the console output summary.
Track reports:\n${JSON.stringify(results.filter(Boolean).map(r => ({ key: r.key, final: r.final })))}`, { label: 'e2e', phase: 'E2E', schema: REPORT })

phase('Integrate')
const integ = await agent(`${COMMON}\nFinal integration: pnpm install (if needed), pnpm -r build, pnpm -r test, cd contracts && forge test, and run scripts/e2e.ts once. Fix only integration breakages. Secret scan (exclude node_modules, .git, dist, .next, out, cache): no private keys / anvil default private keys / API keys in files. List leftover temp files (don't delete). Also grep for inline time-unit math outside packages/shared/units.ts (rule 7) and report. Return counts per package.`, { label: 'entegrasyon', phase: 'Integrate', schema: REPORT })
return { prep, tracks: results.filter(Boolean), e2e, integ }
