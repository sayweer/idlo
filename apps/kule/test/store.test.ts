import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActionStore, StoreError, type ActionRecord } from "../src/store.js";
import { JsonlLogger } from "../src/logger.js";
import { redact, truncDecimal } from "../src/util.js";
import { TestClock } from "./helpers.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "kule-store-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const rec = (id: string, over: Partial<ActionRecord> = {}): ActionRecord => ({
  actionId: id,
  clOrdId: `plt${id}`,
  state: "RESERVED",
  agent: "0x4444444444444444444444444444444444444444",
  paper: false,
  amountTL: 100,
  reservedAtMs: 1,
  updatedAtMs: 1,
  ...over,
});

describe("kalıcı durum (JSON, fsync + atomik rename)", () => {
  it("reserve diske yazar, ikinci reserve false; yeniden açınca RESERVED/PLACED belirsiz işaretlenir", async () => {
    const d = tmp();
    const p = join(d, "data", "kule-actions.json");
    const s = new ActionStore(p);
    expect(await s.reserve(rec("1"))).toBe(true);
    expect(await s.reserve(rec("1"))).toBe(false);
    await s.update("1", { state: "PLACED", pxE6: 49_000_000, sz: "1", placedAtMs: 5 }, 5);
    await s.reserve(rec("2", { state: "REPORTED" }));
    const onDisk = JSON.parse(readFileSync(p, "utf8")) as { version: number; actions: Record<string, ActionRecord> };
    expect(onDisk.version).toBe(1);
    expect(onDisk.actions["1"]?.state).toBe("PLACED");
    expect(readdirSync(join(d, "data"))).toEqual(["kule-actions.json"]); // geçici dosya kalmaz

    const s2 = new ActionStore(p);
    expect(s2.get("1")).toMatchObject({ state: "PLACED", uncertain: true });
    expect(s2.get("2")).toMatchObject({ state: "REPORTED" });
    expect(s2.get("2")?.uncertain).toBeUndefined();
    expect(s2.anyUncertain()).toBe(true);
    await s2.delete("1");
    expect(new ActionStore(p).get("1")).toBeUndefined();
  });

  it("eşzamanlı reserve: aynı actionId için yalnız biri kazanır", async () => {
    const s = new ActionStore(join(tmp(), "a.json"));
    const rs = await Promise.all(Array.from({ length: 10 }, () => s.reserve(rec("9"))));
    expect(rs.filter(Boolean)).toHaveLength(1);
  });

  it("bozuk dosya → açılışta StoreError (fail-closed, sessizce boş başlamaz)", () => {
    const d = tmp();
    const p = join(d, "bad.json");
    writeFileSync(p, "{yarım");
    expect(() => new ActionStore(p)).toThrow(StoreError);
    writeFileSync(p, JSON.stringify({ version: 2, actions: {} }));
    expect(() => new ActionStore(p)).toThrow(StoreError);
    writeFileSync(p, JSON.stringify({ version: 1, actions: { "5": { actionId: "6", clOrdId: "plt6", state: "RESERVED", agent: "x" } } }));
    expect(() => new ActionStore(p)).toThrow(StoreError);
    writeFileSync(p, JSON.stringify({ version: 1, actions: { "5": { actionId: "5", clOrdId: "plt5", state: "BILINMEYEN", agent: "x" } } }));
    expect(() => new ActionStore(p)).toThrow(StoreError);
  });

  it("disk yazımı başarısızsa reserve fırlatır ve bellekte kayıt kalmaz (emir gönderilmez)", async () => {
    const d = tmp();
    // yazılacak yolun üst "dizini" bir dosya → mkdir/open başarısız
    const blocker = join(d, "blocker");
    writeFileSync(blocker, "x");
    const s = new ActionStore(join(blocker, "kule-actions.json"));
    await expect(s.reserve(rec("3"))).rejects.toThrow(StoreError);
    expect(s.get("3")).toBeUndefined();
    mkdirSync(join(d, "ok"));
  });
});

describe("günlük ve gizli değer ayıklama", () => {
  it("logs/kule-YYYYMMDD.jsonl (TR tarihi) yazar; anahtar/imza/token alanları yazılmaz", () => {
    const d = tmp();
    const clock = new TestClock(Date.parse("2026-10-17T22:30:00.000Z")); // TR: 18 Ekim 01:30
    const lg = new JsonlLogger(join(d, "logs"), clock, "paper");
    const line = lg.log({ tool: "x", token: "SIR-TOKEN", apiKey: "SIR-KEY", OKX_SECRET: "SIR", signature: "0xabc", nested: { passphrase: "SIR-P", ok: 1 } });
    expect(readdirSync(join(d, "logs"))).toEqual(["kule-20261018.jsonl"]);
    const file = readFileSync(join(d, "logs", "kule-20261018.jsonl"), "utf8");
    expect(file.trim()).toBe(line);
    expect(file).not.toContain("SIR");
    expect(JSON.parse(line)).toMatchObject({ mode: "paper", tool: "x", nested: { ok: 1 } });
  });

  it("redact ve truncDecimal", () => {
    expect(redact({ a: "x".repeat(3000) })).toEqual({ a: "x".repeat(2000) + "…" });
    expect(truncDecimal("49.4476123", 6)).toBe("49.447612");
    expect(truncDecimal("1.000", 6)).toBe("1");
    expect(truncDecimal("", 6)).toBe("0");
    expect(truncDecimal(undefined, 6)).toBe("0");
    expect(() => truncDecimal("1e5", 6)).toThrow();
  });
});
