// The only four eases on the landing (DESIGN.md §6). "none" is used for scroll-linked scrub and
// instant toggles only.
export const LAND = "expo.out";
export const POP = "back.out(1.6)";
export const SHIFT = "power4.inOut";
export const LEAVE = "expo.in";

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** Thousands separator follows the page language (2,000 / 2.000). */
export const fmt = (n: number) =>
  Math.round(n).toLocaleString(document.documentElement.lang === "tr" ? "tr-TR" : "en-US");

/** Resting tilt of a card, read from its inline `--r` custom property. */
export const baseRot = (el: Element) => parseFloat(getComputedStyle(el).getPropertyValue("--r")) || 0;

export type Point = { x: number; y: number };
