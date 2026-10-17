/**
 * A3 register-agent: düşmanca senaryolar (yanlış zincir, eksik/bozuk fuji.json, çift kayıt, yanlış olaydan agentId,
 * fuji.json'daki diğer alanların ezilmesi, anahtar sızıntısı). Sahte RPC istemcileriyle; ağ yok, gönderim yok.
 * Anahtar her çalıştırmada üretilir (generatePrivateKey); dosyaya yazılmaz.
 * TODO(spec): §18'de A3 için kimlik yok; testler §17.2 adım kimliği "A3" ile adlandırıldı.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createWalletClient, encodeAbiParameters, encodeEventTopics, http, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ERC8004_FUJI, parseDeployments } from "@pilot/shared";
import { buildAgentCard, validateAgentUri } from "../lib/agentCard.js";
import { identityRegistryAbi, type RegistryLog } from "../lib/erc8004.js";
import { parseCliArgs, registerAgent, type RegisterDeps, type RegisterOptions } from "../lib/registerAgent.js";

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
// tsx'in JS girişi node ile çalıştırılır: .bin/tsx Windows'ta doğrudan spawn edilemez (ENOENT, yalnız tsx.CMD var).
const TSX_CLI = join(SCRIPTS_DIR, "..", "node_modules", "tsx", "dist", "cli.mjs");
const EXAMPLE = JSON.parse(readFileSync(join(SCRIPTS_DIR, "..", "deployments", "fuji.example.json"), "utf8"));
const CARD = buildAgentCard({ imageUrl: "https://pilot.test/pilot.png", mcpEndpoint: "https://servis.pilot.test/mcp" });
const URI = "https://pilot.test/agent.json";
const FOREIGN: Address = "0x000000000000000000000000000000000000dEaD";
const TX: Hex = `0x${"ab".repeat(32)}`;

const KEY: Hex = generatePrivateKey();
const ACCOUNT = privateKeyToAccount(KEY);
const OTHER = privateKeyToAccount(generatePrivateKey());

const { agentId: _drop, ...BASE } = EXAMPLE;
const fileText = (over: Record<string, unknown> = {}) => JSON.stringify({ ...BASE, deployer: ACCOUNT.address, ...over }, null, 2);

const registered = (id: bigint, owner: Address = ACCOUNT.address, address: Address = ERC8004_FUJI.identity): RegistryLog => ({
  address,
  topics: encodeEventTopics({ abi: identityRegistryAbi, eventName: "Registered", args: { agentId: id, owner } }) as Hex[],
  data: encodeAbiParameters([{ type: "string" }], [URI]),
});
const transfer = (id: bigint, to: Address = ACCOUNT.address, from: Address = zeroAddress, address: Address = ERC8004_FUJI.identity): RegistryLog => ({
  address,
  topics: encodeEventTopics({ abi: identityRegistryAbi, eventName: "Transfer", args: { from, to, tokenId: id } }) as Hex[],
  data: "0x",
});

interface FakeOpts {
  chainId?: number;
  code?: Hex;
  logs?: RegistryLog[];
  status?: "success" | "reverted";
  receiptError?: Error;
  account?: typeof ACCOUNT;
  card?: unknown;
  /** readFile çağrı sırasına göre dönen metinler; son eleman tekrar eder. */
  files: (string | null)[];
}

function fake(o: FakeOpts) {
  const calls: string[] = [];
  const simulated: Address[] = [];
  const written: { path: string; text: string }[] = [];
  const lines: string[] = [];
  let reads = 0;
  const publicClient = {
    getChainId: async () => (calls.push("getChainId"), o.chainId ?? 43113),
    getCode: async () => (calls.push("getCode"), o.code ?? "0x6000"),
    simulateContract: async (a: { address: Address }) => {
      calls.push("simulate");
      simulated.push(a.address);
      return { result: 41n, request: { address: a.address } };
    },
    waitForTransactionReceipt: async () => {
      calls.push("wait");
      if (o.receiptError) throw o.receiptError;
      return { status: o.status ?? "success", logs: o.logs ?? [transfer(41n), registered(41n)] };
    },
  };
  const acct = o.account ?? ACCOUNT;
  const walletClient = {
    account: acct,
    writeContract: async () => (calls.push("send"), TX),
  };
  const deps = {
    publicClient,
    walletClient,
    readFile: async () => {
      calls.push("readFile");
      return o.files[Math.min(reads++, o.files.length - 1)] ?? null;
    },
    writeFile: async (path: string, text: string) => {
      calls.push("writeFile");
      written.push({ path, text });
    },
    fetchJson: async () => (calls.push("fetch"), o.card ?? CARD),
    log: (l: string) => lines.push(l),
  } as unknown as RegisterDeps;
  return { deps, calls, simulated, written, lines };
}

const opts = (over: Partial<RegisterOptions> = {}): RegisterOptions => ({
  deploymentsPath: "/tmp/a3-adv/fuji.json",
  agentUri: URI,
  rpcUrl: "http://127.0.0.1:1",
  local: false,
  force: false,
  broadcast: true,
  ...over,
});

describe("A3 düşman: yanlış zincir", () => {
  it.each([1, 43114, 31337, 0])("A3 zincir %i (Fuji değil) → --local olmadan ret; simülasyon, gönderim, yazım yok", async (chainId) => {
    const f = fake({ chainId, files: [fileText()] });
    await expect(registerAgent(opts(), f.deps)).rejects.toThrow(/Fuji \(43113\) bekleniyor/);
    expect(f.calls).not.toContain("simulate");
    expect(f.calls).not.toContain("send");
    expect(f.calls).not.toContain("writeFile");
  });

  it("A3 Fuji yolunda opts.registry verilse bile yalnız Ek B Identity adresi kullanılır", async () => {
    const f = fake({ files: [fileText()] });
    await registerAgent(opts({ registry: FOREIGN }), f.deps);
    expect(f.simulated).toEqual([ERC8004_FUJI.identity]);
  });

  it("A3 CLI: --registry yalnız --local ile; --local adres ister; geçersiz adres reddedilir", () => {
    const base = ["--agent-uri", URI, "--rpc", "http://x"];
    expect(() => parseCliArgs([...base, "--registry", FOREIGN], {}, "d.json")).toThrow(/yalnız --local/);
    expect(() => parseCliArgs([...base, "--local"], {}, "d.json")).toThrow(/--registry/);
    expect(() => parseCliArgs([...base, "--local", "--registry", "0x1234"], {}, "d.json")).toThrow(/--registry/);
    expect(() => parseCliArgs([...base, "--broadcast=true"], {}, "d.json")).toThrow(/bilinmeyen/);
  });

  // Not: "/x/fuji.json/." basename "." verir ama gerçek fs okumayı ENOTDIR ile reddeder; burada sahte fs olduğu için yok.
  it.each(["/x/deployments/fuji.json", "./fuji.json", "/x/.anvil/../fuji.json"])(
    "A3 --local gerçek dosyaya yazamaz (%s) → hiçbir RPC çağrısı yok",
    async (deploymentsPath) => {
      const f = fake({ chainId: 31337, files: [fileText()] });
      await expect(registerAgent(opts({ local: true, registry: FOREIGN, deploymentsPath }), f.deps)).rejects.toThrow();
      expect(f.calls.filter((c) => c !== "readFile")).toEqual([]);
      expect(f.written).toEqual([]);
    },
  );
});

describe("A3 düşman: eksik/bozuk fuji.json", () => {
  it.each([
    ["yok", null],
    ["boş", "  \n"],
    ["bozuk JSON", "{"],
    ["dizi", "[]"],
    ["Avalanche ana ağı", fileText({ chainId: 43114 })],
    ["Ek B dışı Identity", fileText({ erc8004: { ...BASE.erc8004, identity: FOREIGN } })],
    ["sıfır deployer", fileText({ deployer: zeroAddress })],
    ["agentId sayı", fileText({ agentId: 41 })],
    ["agentId null", fileText({ agentId: null })],
    ["agentId başında sıfır", fileText({ agentId: "041" })],
  ])("A3 fuji.json %s → zincire hiç dokunulmadan ret", async (_n, text) => {
    const f = fake({ files: [text] });
    await expect(registerAgent(opts(), f.deps)).rejects.toThrow(/deployments dosyası/);
    expect(f.calls).toEqual(["readFile"]);
  });

  it("A3 imzalayan deployments.deployer değil → simülasyon/gönderim yok, anahtar hata metninde yok", async () => {
    const f = fake({ files: [fileText()], account: OTHER });
    const err = await registerAgent(opts(), f.deps).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/deployer/);
    expect(err?.message).not.toContain(KEY.slice(2));
    expect(f.calls).not.toContain("simulate");
    expect(f.calls).not.toContain("send");
  });
});

describe("A3 düşman: çift kayıt", () => {
  it.each(["17", "0"])("A3 fuji.json'da agentId=%s varken --force olmadan RPC'ye bile gidilmez", async (agentId) => {
    const f = fake({ files: [fileText({ agentId })] });
    await expect(registerAgent(opts(), f.deps)).rejects.toThrow(/zaten kayıtlı/);
    expect(f.calls).toEqual(["readFile"]);
  });

  it("A3 kuru çalıştırma: gönderim ve yazım yok", async () => {
    const f = fake({ files: [fileText()] });
    const r = await registerAgent(opts({ broadcast: false }), f.deps);
    expect(r.dryRun).toBe(true);
    expect(f.calls).not.toContain("send");
    expect(f.calls).not.toContain("writeFile");
  });

  it("A3 başka süreç aynı anda agentId yazdıysa üzerine yazılmaz; KAYIT ZİNCİRDE + tx + agentId bildirilir", async () => {
    const f = fake({ files: [fileText(), fileText({ agentId: "40" })] });
    const p = registerAgent(opts(), f.deps);
    await expect(p).rejects.toThrow(/KAYIT ZİNCİRDE AMA DOSYA YAZILMADI/);
    await expect(p).rejects.toThrow(new RegExp(`${TX}.*agentId 41`));
    expect(f.written).toEqual([]);
  });

  it("A3 dosya çalışma sırasında silindiyse yazılmaz", async () => {
    const f = fake({ files: [fileText(), null] });
    await expect(registerAgent(opts(), f.deps)).rejects.toThrow(/KAYIT ZİNCİRDE/);
    expect(f.written).toEqual([]);
  });

  it("A3 revert edilen kayıt dosyaya yazılmaz", async () => {
    const f = fake({ files: [fileText()], status: "reverted" });
    await expect(registerAgent(opts(), f.deps)).rejects.toThrow(/revert/);
    expect(f.written).toEqual([]);
  });

  it("A3 gönderimden sonra makbuz beklenemezse hata tx hash'ini taşır (yeniden gönderim → çift kayıt riski)", async () => {
    // İşlem gönderildi ama makbuz zaman aşımına uğradı: kayıt zincirde olabilir. Hata kullanıcıyı
    // yeniden --broadcast'e itmemeli; en az tx hash'i ve "zincirde olabilir" uyarısını taşımalı.
    const f = fake({ files: [fileText()], receiptError: new Error("Timed out while waiting for transaction") });
    await expect(registerAgent(opts(), f.deps)).rejects.toThrow(TX);
    expect(f.written).toEqual([]);
  });
});

describe("A3 düşman: agentId yanlış olaydan okunmaz", () => {
  const run = async (logs: RegistryLog[]) => {
    const f = fake({ files: [fileText()], logs });
    const res = await registerAgent(opts(), f.deps).then(
      (r) => ({ ok: true as const, r }),
      (e: Error) => ({ ok: false as const, e }),
    );
    return { ...f, res };
  };

  it("A3 yalnız başka kontratın Registered/Transfer olayları → ret, dosya yazılmaz", async () => {
    const f = await run([registered(999n, ACCOUNT.address, FOREIGN), transfer(999n, ACCOUNT.address, zeroAddress, FOREIGN)]);
    expect(f.res.ok).toBe(false);
    expect(f.written).toEqual([]);
  });

  it("A3 başka kontratın olayı + kaydın basımı → kaydınki (41) yazılır", async () => {
    const f = await run([registered(999n, ACCOUNT.address, FOREIGN), transfer(41n)]);
    expect(f.res.ok).toBe(true);
    expect(parseDeployments(f.written[0]!.text).agentId).toBe("41");
  });

  it("A3 kayıt olayı başka sahibe ait → ret", async () => {
    const f = await run([registered(41n, OTHER.address), transfer(41n, OTHER.address)]);
    expect(f.res.ok).toBe(false);
    expect(f.written).toEqual([]);
  });

  it("A3 basım olmayan Transfer (sahip→başkası) agentId sayılmaz", async () => {
    const f = await run([transfer(99n, OTHER.address, ACCOUNT.address), registered(41n)]);
    expect(f.res.ok && f.res.r.dryRun === false && f.res.r.agentId).toBe(41n);
  });

  it("A3 aynı işlemde iki basım (iki farklı kimlik) → ret", async () => {
    const f = await run([transfer(41n), transfer(42n)]);
    expect(f.res.ok).toBe(false);
    expect(f.written).toEqual([]);
  });

  it("A3 küçük harfli kayıt adresi de eşleşir", async () => {
    const f = await run([{ ...registered(41n), address: ERC8004_FUJI.identity.toLowerCase() as Address }]);
    expect(f.res.ok).toBe(true);
  });

  it("A3 agentId 0 olayı → KAYIT ZİNCİRDE, yazım yok", async () => {
    const f = await run([transfer(0n), registered(0n)]);
    expect(f.res.ok).toBe(false);
    if (!f.res.ok) expect(f.res.e.message).toMatch(/KAYIT ZİNCİRDE/);
    expect(f.written).toEqual([]);
  });
});

describe("A3 düşman: fuji.json'daki diğer alanlar ezilmez", () => {
  it("A3 yazılan dosya = eski alanlar aynen (değer ve sıra) + agentId; şemanın bilmediği alan korunur", async () => {
    const orig = { ...BASE, deployer: ACCOUNT.address, note: { a: [1, "x"] } };
    const text = JSON.stringify(orig, null, 2);
    const f = fake({ files: [text] });
    await registerAgent(opts(), f.deps);
    expect(f.written).toHaveLength(1);
    expect(f.written[0]!.path).toBe(opts().deploymentsPath);
    const out = JSON.parse(f.written[0]!.text);
    expect(out).toEqual({ ...orig, agentId: "41" });
    expect(Object.keys(out)).toEqual([...Object.keys(orig), "agentId"]);
  });

  it("A3 --force yalnız agentId'yi değiştirir, yerini korur", async () => {
    const orig = { agentId: "17", ...BASE, deployer: ACCOUNT.address };
    const f = fake({ files: [JSON.stringify(orig)] });
    await registerAgent(opts({ force: true }), f.deps);
    const out = JSON.parse(f.written[0]!.text);
    expect(out).toEqual({ ...orig, agentId: "41" });
    expect(Object.keys(out)).toEqual(Object.keys(orig));
  });
});

describe("A3 düşman: agentURI zincire doğrulanan biçimiyle yazılır", () => {
  it.each([
    "https://pilot.test/agent.json\n",
    " https://pilot.test/agent.json",
    "https://pilot.test/age\tnt.json",
    "https://pilot.test/agent.json?",
    "https://pilot.test/agent.json#",
    "https://pilot.test/x/../agent.json",
  ])("A3 URL ayrıştırıcısının sessizce düzelttiği agentURI (%j) reddedilir", (uri) => {
    // validateAgentUri new URL(uri) üzerinde denetler ama ham `uri`yi döndürür; register(agentURI) ham metni
    // zincire yazar. Normalleşen biçim denetimi geçerse zincirdeki agentURI denetlenen URL'den farklı olur.
    expect(() => validateAgentUri(uri, { local: false })).toThrow();
  });
});

describe("A3 düşman: anahtar sızıntısı (CLI)", () => {
  const dir = mkdtempSync(join(tmpdir(), "a3-adv-"));
  const deploymentsPath = join(dir, "fuji.json");
  writeFileSync(deploymentsPath, fileText());
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const runCli = (env: Record<string, string>, rpc: string) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, [TSX_CLI, join(SCRIPTS_DIR, "register-agent.ts"), "--agent-uri", URI, "--rpc", rpc, "--deployments", deploymentsPath], {
        env: { PATH: process.env.PATH ?? "", ...env },
      });
      let out = "";
      p.stdout.on("data", (b) => (out += b));
      p.stderr.on("data", (b) => (out += b));
      p.on("close", (code) => resolve({ code, out }));
    });

  const closedPort = () =>
    new Promise<number>((res) => {
      const s = createNetServer().listen(0, "127.0.0.1", () => {
        const port = (s.address() as AddressInfo).port;
        s.close(() => res(port));
      });
    });

  it.each([
    ["0x'siz", KEY.slice(2)],
    ["kısa", KEY.slice(0, -1)],
    ["CRLF'li", `${KEY}\r`],
    ["boşluklu", ` ${KEY}`],
  ])("A3 biçimi bozuk anahtar (%s) → çıkış 1, anahtar çıktıda yok", async (_n, bad) => {
    const r = await runCli({ DEPLOYER_PRIVATE_KEY: bad }, "http://127.0.0.1:1");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/DEPLOYER_PRIVATE_KEY/);
    expect(r.out).not.toContain(KEY.slice(4, -2));
  }, 30_000);

  it("A3 geçerli anahtar + ulaşılamayan RPC → çıkış 1, anahtar çıktıda yok, dosya değişmez", async () => {
    const before = readFileSync(deploymentsPath, "utf8");
    const r = await runCli({ DEPLOYER_PRIVATE_KEY: KEY }, `http://127.0.0.1:${await closedPort()}`);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/HATA/);
    expect(r.out).not.toContain(KEY.slice(2));
    expect(r.out.toLowerCase()).not.toContain(KEY.slice(2).toLowerCase());
    expect(readFileSync(deploymentsPath, "utf8")).toBe(before);
  }, 60_000);

  it("A3 registerAgent günlük satırları ve hataları anahtarı içermez (gerçek viem cüzdan istemcisi)", async () => {
    const f = fake({ files: [fileText()] });
    const walletClient = createWalletClient({ account: ACCOUNT, transport: http("http://127.0.0.1:1") });
    const deps = { ...f.deps, walletClient: Object.assign(walletClient, { writeContract: async () => TX }) } as RegisterDeps;
    await registerAgent(opts(), deps);
    expect(f.lines.join("\n")).not.toContain(KEY.slice(2));
    expect(f.written[0]!.text).not.toContain(KEY.slice(2));
  });
});
