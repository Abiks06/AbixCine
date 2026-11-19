/**
 * Plays the one-shot `.burst` halo (styles/base.css) on an element, restarting it if it is
 * already running, and cleans the class up afterwards. Used when a title joins My List.
 */
export function burst(el: Element | null | undefined) {
  if (!(el instanceof HTMLElement)) return;
  el.classList.remove("burst");
  void el.offsetWidth; // restart the animation if a second add lands mid-burst
  el.classList.add("burst");
  el.addEventListener("animationend", function done(e) {
    if (e.target !== el || e.animationName !== "listBurst") return;
    el.classList.remove("burst");
    el.removeEventListener("animationend", done);
  });
}
