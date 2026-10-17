import { describe, expect, it } from "vitest";
import {
  UnitError,
  assertTL,
  cycleIdOf,
  cycleIdParts,
  assertCycleId,
  deadlineEndSec,
  decimalToScaled,
  floorToTick,
  formatDecimalTr,
  formatPxTr,
  formatTL,
  halfTL,
  hoursToDeadline,
  isOnTick,
  limitBuySz,
  marketBuySzTL,
  msToSec,
  notionalDeviationBps,
  notionalTLE6,
  parseOkxTs,
  parseTL,
  pxE6FromChain,
  pxE6ToPx,
  pxToPxE6,
  scaledToDecimal,
  secToMs,
  tlFromChain,
  tlToChain,
  trDateToSec,
  trDay,
  trParts,
} from "../units.js";

const utc = (s: string) => Date.parse(s) / 1000;

describe("TL (tam lira)", () => {
  it("tamsayı TL kabul edilir, kuruşlu / negatif / NaN reddedilir", () => {
    expect(assertTL(20000)).toBe(20000);
    expect(assertTL(0)).toBe(0);
    for (const bad of [10.5, -1, Number.NaN, Infinity, "10", 2 ** 53, null]) {
      expect(() => assertTL(bad)).toThrow(UnitError);
    }
  });
  it("parseTL yalnız rakam kabul eder", () => {
    expect(parseTL("20000")).toBe(20000);
    for (const bad of ["20.000", "20000,50", "-5", "", " 1", "01", "1e4"]) expect(() => parseTL(bad)).toThrow(UnitError);
  });
  it("zincir uint64 ↔ number", () => {
    expect(tlToChain(40000)).toBe(40000n);
    expect(tlFromChain(40000n)).toBe(40000);
    expect(() => tlFromChain(2n ** 60n)).toThrow(UnitError);
    expect(() => tlFromChain(-1n)).toThrow(UnitError);
  });
  it("halfTL aşağı yuvarlar", () => {
    expect(halfTL(10000)).toBe(5000);
    expect(halfTL(10001)).toBe(5000);
  });
});

describe("Ondalık string matematiği", () => {
  it("float kayması yok: 0.1 + 0.2 türü değerler tam", () => {
    expect(decimalToScaled("0.3", 6)).toBe(300000n);
    expect(decimalToScaled("1.000000000", 6)).toBe(1000000n); // sondaki sıfırlar kabul
    expect(() => decimalToScaled("1.0000001", 6)).toThrow(UnitError); // ince hane reddedilir
    expect(scaledToDecimal(300000n, 6)).toBe("0.3");
    expect(scaledToDecimal(5n, 6)).toBe("0.000005");
    expect(scaledToDecimal(12n, 0)).toBe("12");
  });
  it("geçersiz biçimler reddedilir", () => {
    for (const bad of ["", ".5", "1.", "-1", "1e3", "49,39", "049.39", " 1", "0x10"]) {
      expect(() => decimalToScaled(bad, 6)).toThrow(UnitError);
    }
  });
});

describe("Fiyat pxE6 (§7)", () => {
  it("49,39 → 49390000 ve geri", () => {
    expect(pxToPxE6("49.39")).toBe(49390000);
    expect(pxE6ToPx(49390000)).toBe("49.39");
    expect(pxToPxE6("33.83")).toBe(33830000);
    expect(pxToPxE6("0.000001")).toBe(1);
  });
  it("float olarak hatalı çıkan fiyatlar tam çevrilir", () => {
    // 4.35 * 1e6 = 4349999.999999999 (float); string matematiği tam
    expect(pxToPxE6("4.35")).toBe(4350000);
    expect(pxToPxE6("34.60")).toBe(34600000);
  });
  it("sıfır, eksi, 6 haneden ince fiyat reddedilir", () => {
    for (const bad of ["0", "0.0", "-49.39", "49.3900001", "49,39"]) expect(() => pxToPxE6(bad)).toThrow(UnitError);
    expect(() => pxE6ToPx(0)).toThrow(UnitError);
    expect(() => pxE6ToPx(1.5)).toThrow(UnitError);
  });
  it("zincirden pxE6 (avgPx 0 = dolum yok)", () => {
    expect(pxE6FromChain(0n)).toBe(0);
    expect(pxE6FromChain(49390000n)).toBe(49390000);
    expect(() => pxE6FromChain(2n ** 64n)).toThrow(UnitError);
  });
});

describe("U-14 (birim düzeyi) fiyat tickSz'ye aşağı yuvarlanır; sz × px ≤ amountTL", () => {
  it("floorToTick aşağı yuvarlar", () => {
    expect(floorToTick(49358000, "0.01")).toBe(49350000);
    expect(floorToTick(49350000, "0.01")).toBe(49350000);
    expect(floorToTick(49359999, "0.001")).toBe(49359000);
    expect(isOnTick(49350000, "0.01")).toBe(true);
    expect(isOnTick(49355000, "0.01")).toBe(false);
  });
  it("geçersiz tickSz reddedilir", () => {
    expect(() => floorToTick(49350000, "0")).toThrow(UnitError);
    expect(() => floorToTick(49350000, "0.0000001")).toThrow(UnitError);
    expect(() => floorToTick(5000, "0.01")).toThrow(UnitError); // sonuç sıfır
  });
  it("limitBuySz: lotSz katı, aşağı yuvarlanmış, sz × px ≤ amountTL", () => {
    const sz = limitBuySz({ amountTL: 10000, pxE6: 49350000, lotSz: "0.0001", minSz: "1" });
    expect(sz).toBe("202.6342");
    expect(notionalTLE6(sz, 49350000) <= 10000n * 1_000_000n).toBe(true);
    expect(limitBuySz({ amountTL: 10000, pxE6: 49350000, lotSz: "1", minSz: "1" })).toBe("202");
    expect(limitBuySz({ amountTL: 10000, pxE6: 50000000, lotSz: "0.01", minSz: "0.5" })).toBe("200");
  });
  it("limitBuySz: minSz altı ve geçersiz girdi reddedilir", () => {
    expect(() => limitBuySz({ amountTL: 10, pxE6: 49350000, lotSz: "0.0001", minSz: "1" })).toThrow(UnitError);
    expect(() => limitBuySz({ amountTL: 10000.5, pxE6: 49350000, lotSz: "0.0001", minSz: "1" })).toThrow(UnitError);
    expect(() => limitBuySz({ amountTL: 10000, pxE6: 0, lotSz: "0.0001", minSz: "1" })).toThrow(UnitError);
    expect(() => limitBuySz({ amountTL: 10000, pxE6: 49350000, lotSz: "0", minSz: "1" })).toThrow(UnitError);
  });
  it("piyasa alışında sz TL'dir", () => {
    expect(marketBuySzTL(10000)).toBe("10000");
    expect(() => marketBuySzTL(0)).toThrow(UnitError);
  });
});

describe("U-2 / U-3 (birim düzeyi) sapma hesabı", () => {
  it("U-2 TL'yi USDT sanan sz (10000 @ 49,35) çok büyük sapma verir", () => {
    expect(notionalDeviationBps("10000", 49350000, 10000)).toBeGreaterThan(100);
  });
  it("U-3 %1 sınırı: tam tutar 0 bp, %1'den fazla sapma > 100 bp", () => {
    expect(notionalDeviationBps("200", 50000000, 10000)).toBe(0);
    expect(notionalDeviationBps("202", 50000000, 10000)).toBe(100);
    expect(notionalDeviationBps("202.1", 50000000, 10000)).toBeGreaterThan(100);
    expect(notionalDeviationBps("197.9", 50000000, 10000)).toBeGreaterThan(100);
  });
});

describe("Zaman: zincir saniye ↔ OKX ms", () => {
  it("dönüşümler", () => {
    expect(secToMs(1722820500)).toBe(1722820500000);
    expect(msToSec(1722820500999)).toBe(1722820500);
    expect(parseOkxTs("1722820500000")).toBe(1722820500000);
  });
  it("geçersiz zaman reddedilir", () => {
    expect(() => secToMs(-1)).toThrow(UnitError);
    expect(() => secToMs(1.5)).toThrow(UnitError);
    expect(() => msToSec(Number.NaN)).toThrow(UnitError);
    for (const bad of ["", "-1", "1.5", "abc", "12345678901234567"]) expect(() => parseOkxTs(bad)).toThrow(UnitError);
  });
});

describe("Türkiye saati (sabit UTC+3) ve döngü", () => {
  it("F-10 TR günü UTC 21:00'de bir sonraki güne geçer", () => {
    expect(trDay(utc("2026-10-04T20:59:59Z"))).toBe(4);
    expect(trDay(utc("2026-10-04T21:00:00Z"))).toBe(5);
  });
  it("yaz saati yok: yıl boyu +3", () => {
    expect(trParts(utc("2026-01-15T12:00:00Z")).hour).toBe(15);
    expect(trParts(utc("2026-07-15T12:00:00Z")).hour).toBe(15);
  });
  it("döngü YYYYMM TR saatine göre; ay sonu UTC 21:00'de değişir", () => {
    expect(cycleIdOf(utc("2026-10-31T20:59:59Z"))).toBe(202610);
    expect(cycleIdOf(utc("2026-10-31T21:00:00Z"))).toBe(202611);
    expect(cycleIdOf(utc("2026-12-31T21:00:00Z"))).toBe(202701);
    expect(cycleIdParts(202610)).toEqual({ year: 2026, month: 10 });
    for (const bad of [202613, 202600, 2026100, -1, 202610.5]) expect(() => assertCycleId(bad)).toThrow(UnitError);
  });
  it("trDateToSec TR yerel saatini doğru çevirir; geçersiz gün reddedilir", () => {
    expect(trDateToSec(2026, 10, 5)).toBe(utc("2026-10-04T21:00:00Z"));
    expect(() => trDateToSec(2026, 2, 30)).toThrow(UnitError);
    expect(() => trDateToSec(2026, 13, 1)).toThrow(UnitError);
  });
  it("son günün sonuna kalan saat (§10.4 hoursToDeadline)", () => {
    const now = utc("2026-10-04T21:00:00Z"); // TR 5 Eki 00:00
    expect(deadlineEndSec(now, 5)).toBe(utc("2026-10-05T21:00:00Z"));
    expect(hoursToDeadline(now, 5)).toBe(24);
    expect(hoursToDeadline(utc("2026-10-05T09:00:00Z"), 5)).toBe(12);
    expect(hoursToDeadline(utc("2026-10-06T09:00:00Z"), 5)).toBeLessThan(0);
    expect(() => deadlineEndSec(utc("2026-02-10T09:00:00Z"), 30)).toThrow(UnitError);
  });
});

describe("Türkçe sayı biçimi", () => {
  it("TL ve fiyat", () => {
    expect(formatTL(10000)).toBe("10.000");
    expect(formatTL(1234567)).toBe("1.234.567");
    expect(formatTL(999)).toBe("999");
    expect(formatPxTr(49350000)).toBe("49,35");
    expect(formatPxTr(49000000)).toBe("49");
    expect(formatDecimalTr("202.6342", 1)).toBe("202,6");
    expect(formatDecimalTr("1234.5")).toBe("1.234,5");
  });
});
