# Fuji'ye dağıtım (A2)

Kaynak: SPEC §6.3, §8.5, §17.2 A2, Ek B. Betik: `contracts/script/Deploy.s.sol`. Çıktı: `deployments/fuji.json` (biçim `packages/shared/deployments.ts`, örnek `deployments/fuji.example.json`).

## 1. Cüzdanlar ve AVAX

```bash
cast wallet new   # 3 kez: DEPLOYER, PILOT_AGENT, KULE_REPORTER (üçü ayrı olmalı; betik aynı adresi reddeder)
cast balance <DEPLOYER_ADRESI> --rpc-url https://api.avax-test.network/ext/bc/C/rpc
```

- Faucet: `https://build.avax.network/console/primary-network/faucet` (Builder Hub hesabı). Alternatif: `https://core.app/tools/testnet-faucet/`.
- DEPLOYER ~1 AVAX yeter. Dağıtım ~3,2 M gaz harcar (Anvil ölçümü).

## 2. `contracts/.env`

```bash
cd contracts
cp .env.example .env    # sonra .env'i düzenle; .env git'e girmez
```

| Alan | Değer |
|---|---|
| `FUJI_RPC` | `https://api.avax-test.network/ext/bc/C/rpc` |
| `DEPLOYER_PRIVATE_KEY` | DEPLOYER özel anahtarı (`0x…`) |
| `PILOT_AGENT_ADDRESS` | PILOT_AGENT **adresi** (anahtar değil) |
| `KULE_REPORTER_ADDRESS` | KULE_REPORTER **adresi** (anahtar değil) |

İsteğe bağlı: `DEPLOYMENTS_OUT` (varsayılan `../deployments/fuji.json`). `DEPLOY_LOCAL=1` yalnız yerel Anvil içindir; Fuji'de **koyma**.

## 3. Dağıtım

```bash
cd contracts
set -a; source .env; set +a
forge test                                                        # önce testler geçmeli
forge script script/Deploy.s.sol --rpc-url $FUJI_RPC              # kuru çalıştırma: dosya yazmaz, JSON'u gösterir
forge script script/Deploy.s.sol --rpc-url $FUJI_RPC --broadcast  # gerçek dağıtım + deployments/fuji.json
```

Betik şu durumlarda dağıtmadan durur (fail-closed):
- zincir 43113 değil (`WrongChain`);
- Fuji'de ERC-8004 kayıtlarında kod yok (`RegistryMissing`);
- adreslerden biri boş, sıfır ya da diğeriyle aynı (`BadRole`);
- `deployments/fuji.json` zaten var (`OutputExists`). Yeniden dağıtımda eski dosyayı elle taşı (`mv ../deployments/fuji.json ../deployments/fuji.old.json`). Dikkat: A3'ün yazdığı `agentId` eski dosyada kalır.

Dosya, işlem gönderilmeden önce betik çalışırken yazılır. `--broadcast` hata verirse dosyayı sil ve tekrar çalıştır.

## 4. Doğrulama

```bash
FP=$(jq -r .flightPlan ../deployments/fuji.json)
cast chain-id --rpc-url $FUJI_RPC                     # 43113
cast codesize $FP --rpc-url $FUJI_RPC                 # 0'dan büyük olmalı
cast call $FP 'currentCycleId()(uint32)' --rpc-url $FUJI_RPC   # ör. 202610
cd .. && pnpm --filter @pilot/shared build && node --input-type=module -e \
  "import {parseDeployments} from './packages/shared/dist/index.js'; import {readFileSync} from 'node:fs'; console.log(parseDeployments(readFileSync('deployments/fuji.json','utf8')))"
```

- `deployBlock`, betiğin çalıştığı bloktur. İşlem bundan sonraki bir bloğa girer, bu yüzden olay taraması için güvenli alt sınırdır.
- Gezgin: `https://testnet.snowtrace.io/address/<flightPlan>`.

## 5. Snowtrace kaynak doğrulaması

Derleme ayarları (`solc 0.8.28`, optimizer 200, `cancun`) `foundry.toml`'dan okunur. Kurucunun parametresi yok.

```bash
cd contracts
forge verify-contract $FP src/FlightPlan.sol:FlightPlan \
  --chain-id 43113 \
  --verifier etherscan \
  --verifier-url 'https://api.routescan.io/v2/network/testnet/evm/43113/etherscan' \
  --etherscan-api-key verifyContract \
  --watch
```

`[DOĞRULA]`: Snowtrace'in doğrulama ucu Routescan'dir. Yukarıdaki URL ve yer tutucu anahtar `verifyContract` Routescan belgesinden alınmıştır. Reddedilirse Routescan'den ücretsiz bir API anahtarı al ve onu kullan.

## 6. Sonra

- `deployments/fuji.json` yalnız herkese açık adresler içerir; web'in okuması için git'e eklenir (commit'i sen at).
- A3 (`scripts/register-agent.ts`) aynı dosyaya `agentId` ekler. O gelene kadar web'de imza kapalı kalır.

## Yerel deneme (Anvil)

```bash
anvil --chain-id 43113 --port 18545 &
cd contracts && DEPLOY_LOCAL=1 DEPLOYMENTS_OUT=../deployments/.anvil.json \
  PILOT_AGENT_ADDRESS=<anvil hesap 1> KULE_REPORTER_ADDRESS=<anvil hesap 2> DEPLOYER_PRIVATE_KEY=<anvil hesap 0 anahtarı> \
  forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:18545 --broadcast
```

- Yerel bayrak gerçek `fuji.json`'u yazamaz: `DEPLOYMENTS_OUT` zorunludur ve dosya adı nokta ile başlamalıdır (ör. `.anvil.json`); aksi hâlde `LocalOutRequired`.
- Düz Anvil (31337) dosyasını `parseDeployments` reddeder. Web için `--chain-id 43113` kullan.
- Denemeden sonra `contracts/broadcast/Deploy.s.sol/43113` ve `contracts/cache/Deploy.s.sol/43113` klasörlerini sil, yoksa gerçek Fuji kayıtlarına karışır.
