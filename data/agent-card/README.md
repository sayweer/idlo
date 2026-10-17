# PİLOT kayıt dosyası şablonu (`/agent.json`)

ERC-8004 kayıt dosyası (SPEC §8.5, UI_HANDOFF §2.6). `agent.json` bu klasörde **şablondur**: `ALANADI` yer tutucuları gerçek alan adlarıyla değişmeden yayınlanmaz.

- Üretici: `scripts/lib/agentCard.ts` → `buildAgentCard({ imageUrl, mcpEndpoint, agentId? })` (betikler ve testler için). Web bu modülü içe aktaramaz (`@pilot/scripts` web'in bağımlılığı değil); route handler bu şablonun şeklini birebir üretir, `fuji.json.agentId`'yi JSON sayısı olarak `registrations`'a koyar, `agentId` yoksa `registrations: []`. Zorunlu değerler: UI_HANDOFF §2.6.
- Şablon ile üretici aynı kalmalı: `scripts/test/agentCard.test.ts` bunu denetler.
- `register-agent.ts`, kayıttan önce `--agent-uri` adresindeki dosyayı indirir; şemaya uymazsa ya da `ALANADI` içerirse kayıt yapmaz.
- `[DOĞRULA]` alanları: `type` (EIP-8004 `registration-v1`), `supportedTrust` (`["reputation"]`), `registrations[].agentId`'nin JSON sayısı olması, MCP uç noktasının yolu (TODO(spec), Barış).
