import { describe, expect, it } from "vitest";
import {
  KuleReason,
  RejectCode,
  actionIdFromClOrdId,
  clOrdIdFor,
  execStatusFromChain,
  execStatusToChain,
  healthReasonCode,
  isKuleReasonCode,
  ordTypeFromChain,
  ordTypeToChain,
  rejectCodeName,
  verdictOfReason,
  episodeDirOf,
} from "../codes.js";
import { REJECT_TEXTS, kuleReasonText, quoteReadback, rejectText, optionText } from "../texts.js";

describe("Ret kodları (§8.3)", () => {
  it("zincirdeki uint8 değerleri kontrat sırasıyla aynı", () => {
    expect(RejectCode).toEqual({
      PLAN_INACTIVE: 1,
      OUTSIDE_WINDOW: 2,
      OVER_ORDER_LIMIT: 3,
      OVER_CYCLE_TARGET: 4,
      PRICE_ABOVE_BAND: 5,
      PRICE_UNAVAILABLE: 6,
      BAD_ORDTYPE: 7,
    });
  });
  it("E-4 (kod düzeyi) BuyRejected(3) OVER_ORDER_LIMIT ve Türkçe mesaj", () => {
    expect(rejectCodeName(3)).toBe("OVER_ORDER_LIMIT");
    expect(rejectText(3)).toBe(REJECT_TEXTS.OVER_ORDER_LIMIT);
  });
  it("bilinmeyen kod (0, 8) fırlatır", () => {
    expect(() => rejectCodeName(0)).toThrow();
    expect(() => rejectCodeName(8)).toThrow();
    expect(() => rejectText(8)).toThrow();
  });
  it("her ret kodunun Türkçe mesajı var", () => {
    for (const n of Object.keys(RejectCode)) expect(REJECT_TEXTS[n as keyof typeof RejectCode]).toBeTruthy();
  });
});

describe("Zincir enum'ları", () => {
  it("ordType 0 post_only, 1 ioc; > 1 reddedilir", () => {
    expect(ordTypeToChain("post_only")).toBe(0);
    expect(ordTypeToChain("ioc")).toBe(1);
    expect(ordTypeFromChain(1)).toBe("ioc");
    expect(() => ordTypeFromChain(2)).toThrow();
  });
  it("status 0 FILLED … 3 EXPIRED", () => {
    expect(execStatusToChain("PARTIAL")).toBe(1);
    expect(execStatusFromChain(3)).toBe("EXPIRED");
    expect(() => execStatusFromChain(4)).toThrow();
  });
});

describe("KULE verdict ve gerekçe kodları (§9.2)", () => {
  it("gerekçe → verdict", () => {
    expect(verdictOfReason("NO_AUTHORIZATION")).toBe("RET");
    expect(verdictOfReason("WRONG_AGENT")).toBe("RET");
    expect(verdictOfReason("ABOVE_MAX_PX")).toBe("BEKLET");
    expect(verdictOfReason("SZ_LOOKS_LIKE_TL")).toBe("DÜZELT");
    expect(verdictOfReason(healthReasonCode("PILOT_HEARTBEAT"))).toBe("BEKLET");
  });
  it("HEALTH yalnız HEALTH:<sebep> biçiminde geçerli", () => {
    expect(isKuleReasonCode("HEALTH:DATA_STALE")).toBe(true);
    expect(isKuleReasonCode("HEALTH")).toBe(false);
    expect(isKuleReasonCode("HEALTH:FOO")).toBe(false);
    expect(isKuleReasonCode("TUM_TL_AL")).toBe(false);
  });
  it("her gerekçenin Türkçe mesajı var", () => {
    for (const r of Object.keys(KuleReason)) {
      if (r === "HEALTH") continue;
      expect(kuleReasonText(r as never)).toBeTruthy();
    }
    expect(kuleReasonText("HEALTH:CHAIN_UNREADABLE")).toContain("Zincir");
  });
  it("clOrdId = plt + actionId; en fazla 32 karakter", () => {
    expect(clOrdIdFor("17")).toBe("plt17");
    expect(actionIdFromClOrdId("plt17")).toBe("17");
    expect(() => clOrdIdFor("0")).toThrow();
    expect(() => clOrdIdFor("1".repeat(30))).toThrow();
    expect(() => actionIdFromClOrdId("abc17")).toThrow();
  });
  it("bölüm yönü: TL_GUCLENDI aşağı, diğerleri yukarı", () => {
    expect(episodeDirOf("TL_GUCLENDI")).toBe("down");
    expect(episodeDirOf("KRIPTO_SISMESI")).toBe("up");
  });
});

describe("Türkçe metinler", () => {
  it("readback §9.1 örneğiyle aynı biçim", () => {
    expect(quoteReadback({ amountTL: 10000, sz: "202.6342", pxE6: 49350000, ordType: "post_only" })).toBe(
      "10.000 TL ile yaklaşık 202,6 USDT alınacak (limit 49,35, yalnız yapıcı).",
    );
  });
  it("seçenek metni", () => {
    expect(optionText({ kind: "BUY", amountTL: 10000, ordType: "ioc" })).toBe("10.000 TL al (hemen)");
    expect(optionText({ kind: "WAIT", minutes: 60 })).toBe("60 dk bekle");
  });
});
