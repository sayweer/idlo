import gsap from "gsap";
import { LAND, POP, SHIFT } from "./motion";

/** The cursor is a pushpin: it tilts over things you can pin and squashes on press.
 *  Desktop fine pointers only. Returns a cleanup that removes listeners and the html class. */
export function setupCursor(cur: HTMLElement): () => void {
  const html = document.documentElement;
  html.classList.add("has-cursor");
  gsap.set(cur, { xPercent: -48, yPercent: -95, transformOrigin: "50% 95%", autoAlpha: 0 });
  const qx = gsap.quickTo(cur, "x", { duration: 0.28, ease: LAND });
  const qy = gsap.quickTo(cur, "y", { duration: 0.28, ease: LAND });
  let shown = false;
  let over = false;

  const move = (e: PointerEvent) => {
    if (!shown) {
      shown = true;
      gsap.to(cur, { autoAlpha: 1, duration: 0.2, ease: LAND });
    }
    qx(e.clientX);
    qy(e.clientY);
  };
  const overEl = (e: PointerEvent) => {
    const t = e.target instanceof Element ? e.target.closest(".card.lift,a,.btn") : null;
    if (!!t !== over) {
      over = !!t;
      gsap.to(cur, { rotation: over ? -28 : 0, scale: over ? 1.15 : 1, duration: 0.3, ease: POP });
    }
  };
  const down = () => gsap.to(cur, { scaleY: 0.68, scaleX: 1.25, duration: 0.08, ease: SHIFT });
  const up = () => gsap.to(cur, { scaleY: over ? 1.15 : 1, scaleX: over ? 1.15 : 1, duration: 0.45, ease: POP });

  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("pointerover", overEl);
  window.addEventListener("pointerdown", down);
  window.addEventListener("pointerup", up);
  return () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerover", overEl);
    window.removeEventListener("pointerdown", down);
    window.removeEventListener("pointerup", up);
    html.classList.remove("has-cursor");
  };
}
