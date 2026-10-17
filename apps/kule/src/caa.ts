/**
 * Cancel-All-After (§9.3): ATK'da yok, KULE kendi REST istemcisiyle çağırır.
 *  - İmza: base64(HMAC_SHA256(secret, timestamp + method + path + body)).
 *  - Başlıklar: OK-ACCESS-KEY / SIGN / TIMESTAMP / PASSPHRASE; demo için ayrıca x-simulated-trading: 1.
 *  - Taban URL: https://tr.okx.com.
 *  - 20 sn'de bir, yalnız durum NORMAL ise POST /api/v5/trade/cancel-all-after {"timeOut":"60"}; kapanışta {"timeOut":"0"}.
 * Kimlik bilgileri günlüğe/hataya yazılmaz. TODO(spec): [DOĞRULA] OKX TR spot'ta çalışması ve timeOut aralığı B1 testinde.
 * Uyarı: CAA hesaptaki TÜM emirleri kapsayabilir.
 */
import { createHmac } from "node:crypto";
import type { OkxCreds } from "./config.js";
import type { Logger } from "./logger.js";
import { errText, type Clock } from "./util.js";

export const CAA_PATH = "/api/v5/trade/cancel-all-after";
export const CAA_BASE = "https://tr.okx.com";
export const CAA_TIMEOUT_SEC = 60;
export const CAA_RENEW_MS = 20_000;
/** Son başarılı yenilemeden bu yana geçebilecek süre; aşılırsa "aktif" sayılmaz (yenileme 20 sn'de bir). */
export const CAA_ACTIVE_WINDOW_MS = 45_000;

/** OK-ACCESS-SIGN: base64(HMAC_SHA256(secret, ts + method + path + body)). */
export function okxSign(secret: string, ts: string, method: string, path: string, body: string): string {
  return createHmac("sha256", secret).update(ts + method + path + body, "utf8").digest("base64");
}

export interface CaaOptions {
  creds: OkxCreds;
  demo: boolean;
  clock: Clock;
  fetchImpl?: typeof fetch;
  base?: string;
}

export class CaaClient {
  constructor(private readonly o: CaaOptions) {}

  /** İstek başlıkları ve gövde (test için ayrı). */
  buildRequest(timeOutSec: number): { url: string; headers: Record<string, string>; body: string } {
    const body = JSON.stringify({ timeOut: String(timeOutSec) });
    const ts = new Date(this.o.clock.nowMs()).toISOString();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": this.o.creds.apiKey,
      "OK-ACCESS-SIGN": okxSign(this.o.creds.secretKey, ts, "POST", CAA_PATH, body),
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": this.o.creds.passphrase,
    };
    if (this.o.demo) headers["x-simulated-trading"] = "1";
    return { url: `${this.o.base ?? CAA_BASE}${CAA_PATH}`, headers, body };
  }

  /** timeOut saniye (0 = kapat). Başarısızlıkta fırlatır (hata metni kimlik bilgisi içermez). */
  async set(timeOutSec: number): Promise<void> {
    const req = this.buildRequest(timeOutSec);
    const f = this.o.fetchImpl ?? fetch;
    const res = await f(req.url, { method: "POST", headers: req.headers, body: req.body, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`CAA HTTP ${res.status}`);
    let json: { code?: unknown; msg?: unknown };
    try {
      json = (await res.json()) as { code?: unknown; msg?: unknown };
    } catch {
      throw new Error("CAA yanıtı JSON değil");
    }
    if (json.code !== "0") throw new Error(`CAA OKX kodu ${String(json.code)}: ${String(json.msg ?? "").slice(0, 120)}`);
  }
}

/** CAA durumunu sağlık izleyiciye veren arayüz (test için sahte yazılabilir). */
export interface CaaState {
  isActive(): boolean;
  lastRenewAt(): number | null;
}

export interface CaaLoopOptions {
  client: Pick<CaaClient, "set">;
  clock: Clock;
  /** Durum NORMAL mi (CAA gerekçesi hariç)? */
  isNormal: () => Promise<boolean>;
  logger: Logger;
  intervalMs?: number;
}

/** Yenileme döngüsü: yalnız NORMAL ise timeOut=60; susarsa yenileme durur ve OKX ≤60 sn'de emirleri iptal eder. */
export class CaaLoop implements CaaState {
  private last: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private ticking = false;

  constructor(private readonly o: CaaLoopOptions) {}

  isActive(): boolean {
    return !this.stopped && this.last !== null && this.o.clock.nowMs() - this.last <= CAA_ACTIVE_WINDOW_MS;
  }
  lastRenewAt(): number | null {
    return this.last;
  }

  /** Tek yenileme turu (test ve zamanlayıcı bunu çağırır). Yenilendiyse true. */
  async tick(): Promise<boolean> {
    if (this.stopped || this.ticking) return false;
    this.ticking = true;
    try {
      let normal = false;
      try {
        normal = await this.o.isNormal();
      } catch {
        normal = false;
      }
      if (!normal) return false; // yenileme durur
      try {
        await this.o.client.set(CAA_TIMEOUT_SEC);
        this.last = this.o.clock.nowMs();
        return true;
      } catch (e) {
        this.o.logger.log({ tool: "caa", event: "renew_failed", error: errText(e) });
        return false;
      }
    } finally {
      this.ticking = false;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.o.intervalMs ?? CAA_RENEW_MS);
    this.timer.unref?.();
  }

  /**
   * Kapanış: döngüyü durdurur ve (disarm) {"timeOut":"0"} gönderir.
   * disarm=false: yenileme durur ama geri sayım KAPATILMAZ; açık emir kalmış olabilir, OKX ≤60 sn'de iptal eder.
   */
  async stop(opts: { disarm?: boolean } = {}): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
    if (opts.disarm === false) {
      this.o.logger.log({ tool: "caa", event: "shutdown_left_armed" });
      return;
    }
    try {
      await this.o.client.set(0);
    } catch (e) {
      this.o.logger.log({ tool: "caa", event: "shutdown_failed", error: errText(e) });
    }
  }
}
