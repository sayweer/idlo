import { defineStrings } from "../lib/i18n";

/** Landing metinleri: [english, türkçe]. Landing'i dolduran ajan keyarc'ın sahne sistemini (engine.ts, rope.ts) bu sözlükle besler. */
export const L = defineStrings({
  "l.slogan": ["Give your agent your signed instruction, not your key.", "Ajanına anahtarını değil, imzalı talimatını ver."],
  "l.scene": [
    "The agent decides, the contract permits, KULE places the order. If the contract says no, KULE sends nothing, and that no is on-chain.",
    "Kararı ajan veriyor, izni kontrat veriyor, emri KULE gönderiyor. Kontrat hayır derse KULE emir göndermez ve bu hayır zincirde kayıtlıdır.",
  ],
  "l.start": ["Choose an agent", "Ajan seç"],
  "l.open": ["Open the panel", "Paneli aç"],
});
