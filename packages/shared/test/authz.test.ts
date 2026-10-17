import { describe, expect, it } from "vitest";
import { getAddress, zeroAddress, type Address } from "viem";
import { MIN_OPEN_MARGIN_SEC, checkActionLive, checkActionOwner, type BindingResult, type KuleBinding } from "../authz.js";

const ELIF = getAddress("0x00000000000000000000000000000000000e11f0");
const ATTACKER = getAddress("0x00000000000000000000000000000000000bad00");
const PILOT_AGENT = getAddress("0xabcdef0000000000000000000000000000000001");
const ATTACKER_AGENT = getAddress("0xabcdef0000000000000000000000000000000002");
const KULE_REPORTER = getAddress("0xabcdef0000000000000000000000000000000003");
const OTHER_KULE = getAddress("0xabcdef0000000000000000000000000000000004");
const NOW = 1_790_000_000;

const plan = (o: Partial<{ agent: Address; kule: Address }> = {}) => ({ agent: PILOT_AGENT, kule: KULE_REPORTER, ...o });
const cfg = (o: Partial<KuleBinding> = {}): KuleBinding => ({
  planUser: ELIF,
  kuleReporter: KULE_REPORTER,
  tokenAgent: PILOT_AGENT,
  ...o,
});
const owner = (user: Address, p = plan(), c = cfg()) => checkActionOwner({ user }, p, c);
const live = (o: Partial<{ state: number; openBy: bigint }> = {}, planActive = true, now = NOW) =>
  checkActionLive({ state: 0, openBy: BigInt(NOW + 15 * 60), ...o }, planActive, now);

const reason = (r: BindingResult) => (r.ok ? "OK" : `${r.verdict} ${r.reason}`);

describe("KULE izin sahibi (kilitten önce: §9.2 adım 1 + kullanıcı bağı)", () => {
  it("AUTH-BIND Elif'in kendi planındaki izin geçer", () => {
    expect(owner(ELIF)).toEqual({ ok: true });
  });

  // TODO(spec): §18'de "saldırgan kendi planını kurar" için kimlik yok; AUTH-BIND (AuthBinding.t.sol ile aynı).
  it("AUTH-BIND başka kullanıcının, gerçek KULE ve gerçek PİLOT'u gösteren planındaki izin → RET NO_AUTHORIZATION", () => {
    // Çalınmış PİLOT anahtarı + PILOT_TOKEN: adım 1 geçer, kullanıcı bağı düşürür.
    expect(reason(owner(ATTACKER))).toBe("RET NO_AUTHORIZATION");
  });

  it("U-12 başka kullanıcının kendi ajanını gösteren planı, PILOT_TOKEN ile → RET WRONG_AGENT", () => {
    expect(reason(owner(ATTACKER, plan({ agent: ATTACKER_AGENT })))).toBe("RET WRONG_AGENT");
  });

  it("U-12 plan.agent ≠ token'ın ajanı → RET WRONG_AGENT", () => {
    expect(reason(owner(ELIF, plan(), cfg({ tokenAgent: ATTACKER_AGENT })))).toBe("RET WRONG_AGENT");
  });

  it("AUTH-BIND plan.kule ≠ bu KULE'nin KULE_REPORTER adresi → RET NO_AUTHORIZATION", () => {
    expect(reason(owner(ELIF, plan({ kule: OTHER_KULE })))).toBe("RET NO_AUTHORIZATION");
  });

  it("AUTH-BIND checksum'lı ve küçük harfli adresler eşdeğer", () => {
    const lower = (a: Address) => a.toLowerCase() as Address;
    const r = owner(
      lower(ELIF),
      plan({ agent: lower(PILOT_AGENT), kule: lower(KULE_REPORTER) }),
      cfg({ planUser: ELIF.toLowerCase(), tokenAgent: PILOT_AGENT.toLowerCase() }),
    );
    expect(r).toEqual({ ok: true });
  });

  it("AUTH-BIND sıfır, boş, bozuk, büyük harfli ya da yanlış checksum'lı yapılandırma → RET NO_AUTHORIZATION (fail-closed)", () => {
    // Karışık harf, tek harfin büyüklüğü çevrilmiş: checksum bozuk.
    const i = PILOT_AGENT.slice(2).search(/[a-fA-F]/) + 2;
    const c = PILOT_AGENT[i]!;
    const badChecksum = PILOT_AGENT.slice(0, i) + (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) + PILOT_AGENT.slice(i + 1);
    const upper = "0x" + PILOT_AGENT.slice(2).toUpperCase();
    for (const bad of ["", zeroAddress, "0x12", "elif", badChecksum, upper, `${PILOT_AGENT}\r`]) {
      expect(reason(owner(ELIF, plan(), cfg({ planUser: bad })))).toBe("RET NO_AUTHORIZATION");
      expect(reason(owner(ELIF, plan(), cfg({ kuleReporter: bad })))).toBe("RET NO_AUTHORIZATION");
      expect(reason(owner(ELIF, plan(), cfg({ tokenAgent: bad })))).toBe("RET NO_AUTHORIZATION");
    }
  });

  it("U-4 var olmayan izin (user = 0) → RET NO_AUTHORIZATION", () => {
    expect(reason(owner(zeroAddress))).toBe("RET NO_AUTHORIZATION");
  });
});

describe("KULE izin canlılığı (sağlıktan sonra: §9.2 adım 4, 5)", () => {
  it("U-4 AUTHORIZED izin, aktif plan, yeterli zaman payı geçer", () => {
    expect(live()).toEqual({ ok: true });
  });

  it("U-4 AUTHORIZED olmayan (REPORTED) izin → RET NO_AUTHORIZATION", () => {
    expect(reason(live({ state: 1 }))).toBe("RET NO_AUTHORIZATION");
  });

  it("U-5 süresi dolmuş izin (EXPIRED) → RET NO_AUTHORIZATION", () => {
    expect(reason(live({ state: 2 }))).toBe("RET NO_AUTHORIZATION");
  });

  it("U-4 iptal edilmiş ya da süresi dolmuş plan (isPlanActive = false) → RET NO_AUTHORIZATION", () => {
    expect(reason(live({}, false))).toBe("RET NO_AUTHORIZATION");
  });

  it("U-4 geçersiz saat (NaN, negatif) → RET NO_AUTHORIZATION (fail-closed)", () => {
    expect(reason(live({}, true, Number.NaN))).toBe("RET NO_AUTHORIZATION");
    expect(reason(live({}, true, -1))).toBe("RET NO_AUTHORIZATION");
  });

  it("U-13 openBy − now < 12 dk → RET TOO_LATE; tam 12 dk geçer", () => {
    const at = (s: number) => live({ openBy: BigInt(NOW + s) });
    expect(reason(at(MIN_OPEN_MARGIN_SEC - 1))).toBe("RET TOO_LATE");
    expect(reason(at(-60))).toBe("RET TOO_LATE");
    expect(at(MIN_OPEN_MARGIN_SEC)).toEqual({ ok: true });
  });
});
