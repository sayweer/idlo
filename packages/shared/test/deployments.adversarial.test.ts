import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DeploymentsSchema, ERC8004_FUJI, FUJI_CHAIN_ID, parseDeployments } from "../deployments.js";

// TODO(spec): §18'de dağıtım dosyası için kimlik yok; test adları adım kimliği A2 ile başlar.
// Saldırgan testler: Deploy.s.sol çıktısı ↔ DeploymentsSchema uyumu, tip/checksum tuzakları, anahtar sızıntısı.

const root = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

/** Yerel Anvil (--chain-id 43113) üzerinde `forge script ... --broadcast` çıktısının birebir biçimi
 *  (forge writeJson: sıralı alanlar, sayılar tırnaksız, EIP-55 adresler). Adresler Anvil'in bilinen
 *  varsayılan hesaplarıdır; gerçek dağıtım değildir. */
const FORGE_OUTPUT = `{
  "chainId": 43113,
  "deployBlock": 0,
  "deployer": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "erc8004": {
    "identity": "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    "reputation": "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    "validation": "0x8004Cb1BF31DAf7788923b405b754f57acEB4272"
  },
  "flightPlan": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  "kuleReporter": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "pilotAgent": "0x70997970C51812dC3A010C7D01b50e79c8B8b23F"
}`;
const base = () => JSON.parse(FORGE_OUTPUT) as Record<string, unknown>;
const parse = (v: unknown) => parseDeployments(JSON.stringify(v));

describe("A2 adversarial: Deploy.s.sol ↔ DeploymentsSchema", () => {
  it("A2 forge writeJson çıktısı (deployBlock 0 dahil) olduğu gibi okunur", () => {
    const d = parseDeployments(FORGE_OUTPUT);
    expect(d.chainId).toBe(43113);
    expect(d.deployBlock).toBe(0);
    expect(d.agentId).toBeUndefined();
  });

  it("A2 Deploy.s.sol'ün yazdığı alan adları şemanın alanlarıyla birebir (agentId A3'e kalır)", () => {
    const sol = read("contracts/script/Deploy.s.sol");
    const rootKeys = [...sol.matchAll(/serialize\w+\(root,\s*"(\w+)"/g)].map((m) => m[1]).sort();
    const regKeys = [...sol.matchAll(/serialize\w+\(reg,\s*"(\w+)"/g)].map((m) => m[1]).sort();
    const schemaKeys = Object.keys(DeploymentsSchema.shape).filter((k) => k !== "agentId").sort();
    expect(rootKeys).toEqual(schemaKeys);
    expect(regKeys).toEqual(Object.keys(ERC8004_FUJI).sort());
  });

  it("A2 Deploy.s.sol ERC-8004 adresleri ve zincir kimliği packages/shared ile aynı (Ek B)", () => {
    const sol = read("contracts/script/Deploy.s.sol");
    const c = (name: string) => sol.match(new RegExp(`${name}\\s*=\\s*(0x[0-9a-fA-F]{40})`))?.[1];
    expect(c("ERC8004_IDENTITY")).toBe(ERC8004_FUJI.identity);
    expect(c("ERC8004_REPUTATION")).toBe(ERC8004_FUJI.reputation);
    expect(c("ERC8004_VALIDATION")).toBe(ERC8004_FUJI.validation);
    expect(sol.match(/FUJI_CHAIN_ID\s*=\s*(\d+)/)?.[1]).toBe(String(FUJI_CHAIN_ID));
  });

  it("A2 sayı alanları string ya da kesirli/taşan değer olarak gelirse reddedilir", () => {
    expect(() => parse({ ...base(), chainId: "43113" })).toThrow();
    expect(() => parse({ ...base(), chainId: 43113.0000001 })).toThrow();
    expect(() => parse({ ...base(), deployBlock: "0" })).toThrow();
    expect(() => parse({ ...base(), deployBlock: 1.5 })).toThrow();
    expect(() => parse({ ...base(), deployBlock: null })).toThrow();
    expect(() => parse({ ...base(), deployBlock: Number.MAX_SAFE_INTEGER + 2 })).toThrow();
    // JSON metninde uint256 büyüklüğünde blok: JS'te güvenli tamsayı değil → reddedilir.
    expect(() => parseDeployments(FORGE_OUTPUT.replace('"deployBlock": 0', '"deployBlock": 1e21'))).toThrow();
  });

  it("A2 checksum: karışık harfte bozuk EIP-55 adres reddedilir; küçük harf kabul edilir", () => {
    const fp = base().flightPlan as string; // 0x5FbDB2315678afecb367f032d93F642f64180aa3
    const broken = fp.replace("5FbDB", "5fBDB"); // aynı adres, bozuk checksum
    expect(() => parse({ ...base(), flightPlan: broken })).toThrow();
    expect(() => parse({ ...base(), pilotAgent: (base().pilotAgent as string).replace("dC3A", "Dc3A") })).toThrow();
    expect(parse({ ...base(), flightPlan: fp.toLowerCase() }).flightPlan).toBe(fp.toLowerCase());
    // ERC-8004 adresleri büyük/küçük harften bağımsız Ek B ile eşleşir ama checksum'ı bozuk olan reddedilir.
    const reg = { ...ERC8004_FUJI, identity: ERC8004_FUJI.identity.toLowerCase() };
    expect(parse({ ...base(), erc8004: reg }).erc8004.identity).toBe(reg.identity);
    expect(() => parse({ ...base(), erc8004: { ...ERC8004_FUJI, identity: ERC8004_FUJI.identity.replace("A818", "a818") } })).toThrow();
  });

  it("A2 roller büyük/küçük harf farkıyla ayrı cüzdan gibi gösterilemez", () => {
    const dep = base().deployer as string;
    expect(() => parse({ ...base(), kuleReporter: dep.toLowerCase() })).toThrow();
    expect(() => parse({ ...base(), pilotAgent: dep.toLowerCase() })).toThrow();
  });

  it("A2 zincir: Fuji dışı (Avalanche ana ağı, Ethereum, Anvil) ya da eksik chainId reddedilir", () => {
    for (const id of [43114, 1, 31337, 0, -43113]) expect(() => parse({ ...base(), chainId: id }), String(id)).toThrow();
    const v = base();
    delete v.chainId;
    expect(() => parse(v)).toThrow();
  });

  it("A2 JSON kökü nesne değilse (dizi, sayı, null) reddedilir", () => {
    for (const t of ["[]", "43113", "null", '"x"', `[${FORGE_OUTPUT}]`]) expect(() => parseDeployments(t), t).toThrow();
  });
});

describe("A2 adversarial: anahtar sızıntısı (CLAUDE.md kural 5)", () => {
  const PRIVATE_KEY_HEX = /(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/;

  it("A2 contracts/.env.example anahtar ve adres alanları boş; 32 baytlık hex değer yok", () => {
    const env = read("contracts/.env.example");
    const val = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1];
    expect(val("DEPLOYER_PRIVATE_KEY")).toBe("");
    expect(val("PILOT_AGENT_ADDRESS")).toBe("");
    expect(val("KULE_REPORTER_ADDRESS")).toBe("");
    expect(env).not.toMatch(PRIVATE_KEY_HEX);
    expect(env).not.toMatch(/^DEPLOY_LOCAL=1/m); // örnek dosya yerel kipi açmaz
  });

  it("A2 deployments/ altındaki JSON dosyalarında anahtar biçimli değer ya da anahtar adlı alan yok", () => {
    const dir = new URL("deployments/", root);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const text = readFileSync(new URL(f, dir), "utf8");
      expect(text, f).not.toMatch(PRIVATE_KEY_HEX);
      expect(text, f).not.toMatch(/"[^"]*(private|secret|mnemonic|seed|passphrase)[^"]*"\s*:/i);
    }
  });

  it("A2 Deploy.s.sol anahtarı yalnız Ek B adıyla okur, günlüğe ya da JSON'a yazmaz", () => {
    const sol = read("contracts/script/Deploy.s.sol");
    expect(sol).toMatch(/vm\.envUint\("DEPLOYER_PRIVATE_KEY"\)/);
    expect(sol).not.toMatch(/console2?\.log[^;]*deployerKey/);
    expect(sol).not.toMatch(/serialize\w+\([^;]*deployerKey/);
    expect(sol).not.toMatch(/PILOT_AGENT_PRIVATE_KEY|KULE_REPORTER_PRIVATE_KEY/); // dağıtıcı diğer anahtarları görmez
    expect(sol).not.toMatch(/\brun\(\)[^{]*returns\s*\(\s*Config/); // run() Config'i (anahtarı) dönmez → izde görünmez
  });
});
