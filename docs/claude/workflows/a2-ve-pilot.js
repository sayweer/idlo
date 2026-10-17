export const meta = {
  name: 'a2-ve-pilot',
  description: 'A2 (Deploy.s.sol + fuji.json, yerel deploy testi) ve PİLOT C3–C6 (kural_danis, planFromSentence, araçlar, LLM döngüsü) paralel; kır, incele, düzelt',
  phases: [
    { title: 'Implement', detail: 'A2 ve PİLOT adımları' },
    { title: 'Break', detail: 'saldırgan testler' },
    { title: 'Review', detail: 'SPEC + güvenlik mercekleri' },
    { title: 'Verify', detail: 'bulguları çürütmeye çalış' },
    { title: 'Fix', detail: 'doğrulananları uygula' },
    { title: 'Integrate', detail: 'tüm repo build + test' },
  ],
}
const ROOT = '/Users/seyit/Desktop/idlo'
const COMMON = `Repo: ${ROOT}. docs/SPEC.md is the single source of truth; CLAUDE.md rules apply (re-read rules 1,2,3,7,9,10,11,12). Done so far (committed): packages/shared (@pilot/shared: units, §15 schemas, codes, KULE §9.1 + PİLOT §10.2 tool schemas, deployments.ts reader, authz.ts), contracts (IFlightPlan + FlightPlan, 99 tests), apps/pilot/src/weather (Lira Hava Durumu calc + replay runner, W-1..W-8), scripts/make-replay.ts, data/replays/*.json, docs/UI_HANDOFF.md.
apps/kule is owned by teammate Bekir and is NOT built yet — never write KULE server code; PİLOT must talk to KULE via an interface with a fake implementation validated by the shared KULE zod schemas.
apps/web is owned by Bekir — do not touch.
No state-changing git commands. NEVER write keys; only add empty fields to .env.example. Never broadcast to a real network.
SPEC silent → narrowest safe choice + "TODO(spec): ..." comment. Test names start with SPEC §18 ids.`

const SCHEMA_REPORT = { type: 'object', properties: {
  tests_pass: { type: 'boolean' }, test_summary: { type: 'string' },
  files: { type: 'array', items: { type: 'string' } },
  notes: { type: 'string' },
  todo_spec: { type: 'array', items: { type: 'string' } },
  user_actions: { type: 'array', items: { type: 'string' } },
}, required: ['tests_pass', 'test_summary', 'files', 'notes', 'todo_spec', 'user_actions'] }
const FINDINGS = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: {
  file: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'major', 'minor'] }, spec_ref: { type: 'string' }, issue: { type: 'string' }, suggested_fix: { type: 'string' } },
  required: ['file', 'severity', 'spec_ref', 'issue', 'suggested_fix'] } } }, required: ['findings'] }
const VERDICT = { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] }

async function hardenTrack(key, owns, implReport, breakPrompt, lenses, testCmd) {
  const brk = await agent(`${COMMON}\nYou own (for adding tests only): ${owns}\nImplementation report:\n${implReport}\n\n${breakPrompt}\nKeep passing adversarial tests as regression tests. For failures revealing real bugs per SPEC: keep the test, report precisely, do NOT fix code. Fix/delete tests that misread SPEC. Return summary of tests + bugs.`, { label: `kır:${key}`, phase: 'Break' })
  const reviews = await parallel(lenses.map((l, i) => () => agent(`${COMMON}\nREAD-ONLY reviewer. Track ${key}. Lens: ${l}\nImplementation report:\n${implReport}\nAdversary report:\n${brk}\nInclude real bugs the adversary found. Concrete verifiable defects only, SPEC refs, no nits.`, { label: `incele:${key}:${i + 1}`, phase: 'Review', schema: FINDINGS })))
  const fs = reviews.filter(Boolean).flatMap(r => r.findings)
  const judged = (await parallel(fs.map(f => () => agent(`${COMMON}\nREAD-ONLY. Try to REFUTE this finding against the code and docs/SPEC.md (you may run tests). Not required by SPEC or already satisfied → real=false. Uncertain → real=false.\nFinding: ${JSON.stringify(f)}`, { label: `doğrula:${key}`, phase: 'Verify', schema: VERDICT }).then(v => ({ ...f, verdict: v }))))).filter(Boolean)
  const conf = judged.filter(f => f.verdict.real)
  log(`${key}: ${judged.length} bulgu, ${conf.length} doğrulandı`)
  const fin = await agent(`${COMMON}\nYou own: ${owns}\nApply these verified findings surgically; make every adversarial test pass by fixing code (not tests, unless a test misreads SPEC — explain). Then run ${testCmd} and pnpm -r build.\nFindings:\n${JSON.stringify(conf.map(({ verdict, ...f }) => f), null, 2)}\nAdversary report:\n${brk}\nImplementation report:\n${implReport}`, { label: `düzelt:${key}`, phase: 'Fix', schema: SCHEMA_REPORT })
  return { key, final: fin, confirmed: conf.map(f => ({ severity: f.severity, file: f.file, issue: f.issue })), rejected: judged.length - conf.length }
}

// ---------------- Track A: A2 deploy ----------------
async function trackA() {
  const owns = 'contracts/script/**, contracts/test/Deploy*.t.sol, contracts/.env.example (add empty fields only), deployments/ (format/example only — never write real deployed addresses), packages/shared/deployments.ts + its test, a short docs/DEPLOY.md'
  const impl = await agent(`${COMMON}\nYou own: ${owns}
TASK A2 (§17.2): Read SPEC §6.3, §8.5, Ek B (contracts/.env, addresses, chain id 43113, Snowtrace), §17.2 A2/A3, docs/UI_HANDOFF.md §3.3 (what the web needs from deployments/fuji.json: e.g. flightPlan, deployBlock, agent/kule addresses, erc8004, agentId — marked PLANLI there) and packages/shared/deployments.ts (its TODO(spec)).
1. contracts/script/Deploy.s.sol: deploys FlightPlan using the deployer key from env (env var name exactly as Ek B, via vm.envUint/envAddress — never hardcode), then writes the deployments JSON via vm.writeJson to a path from env (default deployments/fuji.json) with: chainId, flightPlan, deployBlock, deployer, and the public addresses UI needs if SPEC/Ek B defines them (PİLOT agent, KULE reporter, ERC-8004 registries from Ek B). Must refuse (revert) if block.chainid is not 43113 unless an explicit local/anvil flag is set (fail-closed).
2. Finalize packages/shared/deployments.ts schema to match exactly what the script writes (keep fail-closed parse; agentId optional until A3). Update its tests.
3. contracts/test/Deploy.t.sol: runs the script logic against the local test EVM with the local flag and a temp output path (NEVER overwrite deployments/fuji.json), asserts the JSON fields and that wrong chain id reverts.
4. Actually run a local end-to-end: start anvil in background on a free port, run forge script ... --rpc-url local --broadcast with anvil's well-known test key passed via env ONLY in the shell (never write it to any file), output to a temp path, then parse that file with parseDeployments from @pilot/shared (small tsx check). Kill anvil afterwards.
5. docs/DEPLOY.md (Turkish, short): exact commands the user runs for real Fuji deploy (env vars to set in contracts/.env, faucet note, forge script with --rpc-url $FUJI_RPC --broadcast, Snowtrace verify via forge verify-contract with the right verifier settings for Fuji — mark [DOĞRULA] for verifier URL/API key needs), and how to confirm deployments/fuji.json.
Run forge test and pnpm --filter @pilot/shared test. Return report; put the commands the user must run in user_actions.`, { label: 'yaz:A2', phase: 'Implement', schema: SCHEMA_REPORT })
  return hardenTrack('A2', owns, JSON.stringify(impl),
    'ADVERSARY for the deploy path: try wrong chain id, missing env vars, output path overwriting deployments/fuji.json in tests, JSON fields mismatching packages/shared parseDeployments (types: string vs number for chainId/deployBlock, checksum), script leaking key material to logs/files, broadcast without explicit intent. Add tests (forge and/or vitest).',
    ['SPEC fidelity: Deploy.s.sol + deployments.ts vs §6.3, §8.5, Ek B, §17.2 A2 and UI_HANDOFF §3.3 needs; DEPLOY.md commands correct for Foundry 1.7 and Fuji (chain 43113).',
     'Security: no key written anywhere (grep repo incl. docs, tests, broadcast/ and cache/ dirs — make sure contracts/broadcast and cache are gitignored), fail-closed chain-id guard, test never touches deployments/fuji.json.'],
    'cd contracts && forge test && cd .. && pnpm --filter @pilot/shared test')
}

// ---------------- Track P: PİLOT ----------------
async function trackP() {
  const owns = 'apps/pilot/** (except src/weather internals unless a bug), apps/pilot/.env.example (empty fields only). You may ADD new files under packages/shared only if a shared type is truly missing (do not modify existing shared exports; never edit packages/shared/deployments.ts).'
  const [c3, c6] = await parallel([
    () => agent(`${COMMON}\nYou own: apps/pilot/src/rules/** and apps/pilot/test/rules*.test.ts only.
TASK C3: kural_danis decision table (SPEC §10.4, plus §2, §11, §16 rows it uses). Pure function: input = plan (chain), cycle state, weather (shared Weather schema), time (TR day via units.ts), pending questions etc. as SPEC defines; output = allowed options (shared Option schema) + recommended one + Turkish reasons, exactly per §10.4 incl. weekend rise → ask Elif (v4.1), 72h max wait, window open/closed, deadline day behaviour. Fail-closed: invalid input → no BUY option. Tests D-1…D-8 (§18). Run pnpm --filter pilot test (only your files must pass + don't break others).`, { label: 'yaz:C3 kural_danis', phase: 'Implement', schema: SCHEMA_REPORT }),
    () => agent(`${COMMON}\nYou own: apps/pilot/src/plan/** and apps/pilot/test/plan*.test.ts only.
FIRST invoke the Skill tool with skill "claude-api" and follow it for all Anthropic SDK usage (model ids, tool use / structured output). Model comes from env LLM_MODEL per Ek B (never hardcode a different default than Ek B gives; if Ek B gives none, TODO(spec)).
TASK C6: planFromSentence (SPEC §10.6, §2 step 1, §15 PlanDraft, §16 relevant rows): Turkish sentence → PlanDraft via Claude; output ALWAYS validated with the shared zod PlanDraft schema; each field carries its source (senin cümlenden / varsayılan) and ambiguous input yields questions instead of guesses; LLM failure/invalid JSON → typed error, never a partial plan (fail-closed). Inject the LLM client so tests use a fake. Tests L-1…L-4 per §18 (live-LLM ones: implement but skip unless ANTHROPIC_API_KEY set, label clearly). Run pnpm --filter pilot test.`, { label: 'yaz:C6 planFromSentence', phase: 'Implement', schema: SCHEMA_REPORT }),
  ])
  const c4 = await agent(`${COMMON}\nYou own: apps/pilot/src/tools/**, apps/pilot/src/clients/**, apps/pilot/test/tools*.test.ts.
Context: C3 report ${JSON.stringify(c3)}\nC6 report ${JSON.stringify(c6)}
TASK C4: PİLOT tool layer exactly the §10.2 tools (shared PILOT tool schemas) with their guards (§10.2–§10.5, §16): every input/output zod-validated; izin_iste calls FlightPlan.requestBuy via viem with the agent account from env (user is FIXED from config, never from LLM input); haberleri_oku output always marked untrusted; kullaniciya_sor; hava_durumu uses src/weather; kural_danis uses src/rules; teklif/emir go to KULE through a KuleClient interface: (a) real MCP Streamable HTTP client to KULE (bearer PILOT_TOKEN from env) — implement against the shared KULE tool schemas, (b) FakeKule in-memory implementation for tests/replay that enforces the shared schemas and basic §9.2 verdicts. Chain access through a ChainClient interface with a fake for tests. LLM never sees KULE tools directly — only §10.2. Tests for each tool's guards (use §18 ids where they apply, e.g. E-*/U-* that are PİLOT-side; otherwise descriptive). Run pnpm --filter pilot test.`, { label: 'yaz:C4 araçlar', phase: 'Implement', schema: SCHEMA_REPORT })
  const c5 = await agent(`${COMMON}\nYou own: apps/pilot/src/loop/**, apps/pilot/src/trace/**, apps/pilot/src/index.ts, apps/pilot/test/loop*.test.ts, apps/pilot/.env.example.
FIRST invoke the Skill tool with skill "claude-api" and follow it (tool-use loop, model from env LLM_MODEL per Ek B).
Context: C3 ${JSON.stringify(c3)}\nC4 ${JSON.stringify(c4)}
TASK C5 (§10.1 loop, §10.3, §10.5, §15 Trace, §16, §17.1 'LLM yoksa kural modu'): planner loop every 5 min (simulated clock for REPLAY=data/replays/<date>.json per CLAUDE.md commands), Claude tool use over ONLY the §10.2 tools, every tool call + result + Turkish rationale appended to a Trace (shared schema) persisted to disk; LLM output never trusted (zod), unknown tool / invalid args → recorded error, no action; LLM unavailable → rule mode that follows kural_danis recommendation deterministically, clearly labelled in trace; INJECTION_DEMO flag labelled (rule 12) and never disables a guard; fail-closed on chain/KULE errors. Wire src/index.ts as the runnable entry (pnpm --filter pilot dev). Tests E-1, E-2 (§18) using replay 2025-03-19 + FakeKule + fake chain + fake LLM (scripted tool calls) and rule mode. Run pnpm --filter pilot test and pnpm --filter pilot build. Put anything the user must do (API key etc.) in user_actions.`, { label: 'yaz:C5 döngü', phase: 'Implement', schema: SCHEMA_REPORT })
  const impl = JSON.stringify({ c3, c6, c4, c5 })
  return hardenTrack('PILOT', owns, impl,
    'ADVERSARY for PİLOT: prompt-injection via haberleri_oku/news text trying to make the loop request a bigger amount, another user, or call non-§10.2 tools; LLM returning malformed/oversized args, unknown tools, endless loops (max steps per tick?), amountTL above plan/maxOrder (must be blocked before chain or rejected by chain and recorded), KULE fake returning schema-invalid data, chain errors mid-tick, rule-mode determinism, weekend rise must ask Elif, storm class lock respected by kural_danis, planFromSentence with ambiguous/hostile sentences. Write vitest tests in apps/pilot/test/*adversarial*.test.ts.',
    ['SPEC fidelity: kural_danis vs §10.4 row by row (D-1..D-8 meaningful), tools vs §10.2 names/IO, loop vs §10.1/§10.3/§15 Trace, planFromSentence vs §10.6/L-1..L-4, E-1/E-2 actually exercise the loop.',
     'Security/fail-closed (CLAUDE.md 1,2,3,9,12): LLM sees only §10.2 tools; user fixed from config; all LLM outputs zod-validated; no sz computed in PİLOT (KULE computes sz); no keys in code/logs/traces; untrusted news handling; demo flags labelled and never weaken guards; units only via units.ts.'],
    'pnpm --filter pilot test && pnpm --filter pilot build')
}

phase('Implement')
const tracks = await parallel([() => trackA(), () => trackP()])

phase('Integrate')
const integ = await agent(`${COMMON}\nFinal integration check. Run at repo root: pnpm install (only if lockfile out of date), pnpm -r build, pnpm -r test, and cd contracts && forge test. Fix only integration breakages (surgical). Grep repo (excluding node_modules, contracts/lib, .git, dist, .next) for any private-key-looking value or anvil default keys written to files; report. List untracked temp/scratch files left by agents (do not delete; report). Return counts per package.`, { label: 'entegrasyon', phase: 'Integrate', schema: SCHEMA_REPORT })
return { tracks: tracks.filter(Boolean), integ }
