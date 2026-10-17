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

---

# ERC-8004 kaydı (A3)

Kaynak: SPEC §8.5, §17.2 A3, Ek B; UI_HANDOFF §2.6. Betik: `scripts/register-agent.ts` (çekirdek `scripts/lib/registerAgent.ts`). Kayıt dosyası üreticisi: `scripts/lib/agentCard.ts` (`buildAgentCard`), şablon: `data/agent-card/agent.json`.

## 1. Önce

- A2 bitmiş olmalı: `deployments/fuji.json` var ve `parseDeployments` ile geçerli (§4).
- Web'in `/agent.json` adresi **sabit ve yayında** olmalı (UI_HANDOFF §2.6). Betik kayıttan önce bu adresi indirir. Şu durumlarda kayıt yapmaz: dosya şemaya uymuyorsa, `name` "PİLOT" değilse, kayıt adresi `eip155:43113:0x8004A818…` değilse ya da içinde `ALANADI` yer tutucusu kalmışsa.
- Kaydı **DEPLOYER** cüzdanı yapar. İmzalayan adres `fuji.json.deployer` değilse betik durur. TODO(spec): SPEC kimin kaydedeceğini söylemiyor; en dar seçim bu, sıcak PİLOT anahtarı kullanılmaz.

## 2. Kayıt

```bash
set -a; source contracts/.env; set +a      # FUJI_RPC ve DEPLOYER_PRIVATE_KEY yalnız ortamda kalır
pnpm install && pnpm --filter @pilot/shared build
curl -fsS https://<web>/agent.json | jq .  # yayında mı?
pnpm exec tsx scripts/register-agent.ts --agent-uri https://<web>/agent.json             # kuru çalıştırma: göndermez, yazmaz
pnpm exec tsx scripts/register-agent.ts --agent-uri https://<web>/agent.json --broadcast # gerçek kayıt + fuji.json.agentId
```

Bayraklar: `--rpc URL` (`FUJI_RPC` yerine), `--deployments yol` (varsayılan `deployments/fuji.json`), `--force`, `--local --registry 0x…`.

Betik şu durumlarda işlem göndermeden durur (fail-closed):
- `fuji.json` yok, bozuk ya da şemaya uymuyor;
- `fuji.json` içinde zaten `agentId` var (`--force` ile yeniden kayıt yapılır, eski `agentId`'nin üzerine yazılır; F-4 nedeniyle planı olan kullanıcılar için yeni `agentId` 24 saat bekler);
- `agentURI` https değil, yolu `/agent.json` değil, sorgu/parça/yer tutucu içeriyor ya da kanonik değil (`new URL(uri).href` girdiden farklı: boşluk, büyük harfli alan adı, `:443`, `..`, sonda `?`/`#`). Zincire yazılan metin, denetlenen ve indirilen metnin aynısıdır;
- zincir 43113 değil (`--local` yoksa);
- Identity adresinde (Ek B) kod yok;
- imzalayan `deployer` değil; yayındaki `agent.json` geçersiz; simülasyon revert ediyor.

Gönderim `chain = Avalanche Fuji (43113)` ile yapılır: viem gönderim anında `eth_chainId`'yi yeniden denetler ve imzaya 43113 koyar.

Gönderimden sonra belirsizlik (çift kayıt riski):
- `İŞLEM GÖNDERİLMİŞ OLABİLİR: tx bilinmiyor` (gönderim çağrısı hata verdi) ya da `İŞLEM GÖNDERİLDİ, SONUÇ BİLİNMİYOR: tx 0x…` (makbuz beklenemedi): `fuji.json`'da henüz `agentId` olmadığı için betiği yeniden `--broadcast` ile çalıştırmak PİLOT'u **ikinci kez** kaydeder. Önce Snowtrace'te deployer adresinin son işlemine bak. Kayıt zincirdeyse `agentId`'yi `fuji.json`'a elle ekle; yoksa (işlem düşmüşse) yeniden çalıştır.
- `kayıt işlemi başarısız (revert), zincir değişmedi`: kayıt yok, yeniden denemek güvenli.

İşlemden sonra `agentId`, kontratın yaydığı olaylardan okunur: `Registered(agentId, agentURI, owner)` ve ERC-721 `Transfer(0x0 → owner, agentId)`. İkisi de `[DOĞRULA]` (SPEC olay imzası vermiyor). Olay yoksa, iki olay farklı kimlik gösteriyorsa ya da `agentId = 0` ise dosya **yazılmaz**. Betik `KAYIT ZİNCİRDE AMA DOSYA YAZILMADI` hatası verir ve işlem özetini basar. Bu durumda olayı Snowtrace'te kontrol et; `agentId`'yi `fuji.json`'a elle ekle ve tekrar `--broadcast` çalıştırma.

## 3. Doğrulama

```bash
jq -r .agentId deployments/fuji.json
ID=$(jq -r .agentId deployments/fuji.json)
cast call 0x8004A818BFB912233c491871b3d84c89A494BD9e 'tokenURI(uint256)(string)' $ID --rpc-url $FUJI_RPC   # [DOĞRULA: ERC-721 tokenURI]
cast call 0x8004A818BFB912233c491871b3d84c89A494BD9e 'ownerOf(uint256)(address)' $ID --rpc-url $FUJI_RPC  # = deployer [DOĞRULA]
```

- Web route handler `fuji.json.agentId`'yi okuyup `registrations` alanını doldurur (biçim ve zorunlu değerler: UI_HANDOFF §2.6, şablon `data/agent-card/agent.json`). Web `scripts/lib/agentCard.ts`'i içe aktaramaz (`@pilot/scripts` web'in bağımlılığı değil, derlenmiş çıktısı yok); değerleri §2.6'dan alır.
- `deployments/fuji.json` git'e eklenir; commit'i sen at.

## Yerel deneme (Anvil)

Testler (`pnpm --filter @pilot/scripts test`) bunu otomatik yapar. Anvil'de küçük bir sahte Identity kaydı (`scripts/test/fixtures/MockIdentityRegistry.sol`) kullanılır; anahtar her çalıştırmada üretilir. Foundry yoksa bu testler atlanır.

Elle denemek için: `--local --registry <yerel kayıt adresi> --rpc http://127.0.0.1:8545 --deployments deployments/.anvil.json`. `--local` ile `--rpc` açıkça verilmeli ve yerel olmalı (127.0.0.1, localhost, [::1]); `FUJI_RPC`'ye düşülmez, böylece `source contracts/.env` sonrası yanlışlıkla gerçek Fuji'ye gönderilmez. TODO(spec). `--local` ile çıktı dosyasının adı nokta ile başlamalıdır, böylece gerçek `fuji.json`'a yazılamaz. Yalnız bu kipte `agentURI` için `http://127.0.0.1` de kabul edilir.
