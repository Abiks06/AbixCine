import { describe, expect, it, vi } from "vitest";
import { handlePlayerKey, type ShortcutContext } from "./shortcuts";
import type { Sheet } from "./shared";

function ctx(over: Partial<ShortcutContext> = {}) {
  let sheet: Sheet | null = null;
  const c: ShortcutContext = {
    video: { current: null },
    sheet,
    setSheet: vi.fn((s) => {
      sheet = typeof s === "function" ? s(sheet) : s;
    }),
    keysOpen: false,
    setKeysOpen: vi.fn(),
    isEmbed: false,
    isFull: false,
    hasEpisodes: true,
    hasSubtitle: () => true,
    poke: vi.fn(),
    toggle: vi.fn(),
    seek: vi.fn(),
    seekTo: vi.fn(),
    changeVol: vi.fn(),
    toggleMute: vi.fn(),
    changeSpeed: vi.fn(),
    toggleSub: vi.fn(),
    cycleSub: vi.fn(),
    nudge: vi.fn(),
    toggleFull: vi.fn(),
    setFull: vi.fn(async () => {}),
    togglePip: vi.fn(async () => {}),
    cycleFit: vi.fn(),
    goNext: vi.fn(),
    goInfo: vi.fn(),
    leave: vi.fn(),
    ...over,
  };
  return { c, sheet: () => sheet };
}

const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });

describe("handlePlayerKey (PERF-06 extraction)", () => {
  it("maps the core keys to player actions", () => {
    const { c } = ctx();
    handlePlayerKey(key(" "), c);
    handlePlayerKey(key("ArrowLeft", { shiftKey: true }), c);
    handlePlayerKey(key("L"), c); // Caps Lock
    handlePlayerKey(key("ArrowUp"), c);
    handlePlayerKey(key("m"), c);
    handlePlayerKey(key("C", { shiftKey: true }), c);
    handlePlayerKey(key("]"), c);
    handlePlayerKey(key("z"), c);
    handlePlayerKey(key("i"), c);
    expect(c.toggle).toHaveBeenCalledOnce();
    expect(c.seek).toHaveBeenNthCalledWith(1, -30);
    expect(c.seek).toHaveBeenNthCalledWith(2, 10);
    expect(c.changeVol).toHaveBeenCalledWith(0.1);
    expect(c.toggleMute).toHaveBeenCalledWith(true);
    expect(c.cycleSub).toHaveBeenCalledOnce();
    expect(c.nudge).toHaveBeenCalledWith(0.5);
    expect(c.cycleFit).toHaveBeenCalledOnce();
    expect(c.goInfo).toHaveBeenCalledOnce();
  });

  it("never repeats toggles on a held key, but repeats seeks", () => {
    const { c } = ctx();
    handlePlayerKey(key("f", { repeat: true }), c);
    handlePlayerKey(key("n", { repeat: true }), c);
    handlePlayerKey(key("ArrowRight", { repeat: true }), c);
    expect(c.toggleFull).not.toHaveBeenCalled();
    expect(c.goNext).not.toHaveBeenCalled();
    expect(c.seek).toHaveBeenCalledWith(5);
  });

  it("leaves modifier shortcuts to the app and keys to text fields", () => {
    const { c } = ctx();
    handlePlayerKey(key("k", { ctrlKey: true }), c);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(key(" "));
    handlePlayerKey(Object.defineProperty(key(" "), "target", { value: input }), c);
    expect(c.toggle).not.toHaveBeenCalled();
    input.remove();
  });

  it("Escape closes the sheet first, then fullscreen, then leaves", () => {
    const withSheet = ctx({ sheet: "servers" });
    handlePlayerKey(key("Escape"), withSheet.c);
    expect(withSheet.c.setSheet).toHaveBeenCalledWith(null);
    const full = ctx({ isFull: true });
    handlePlayerKey(key("Escape"), full.c);
    expect(full.c.setFull).toHaveBeenCalledWith(false);
    const plain = ctx();
    handlePlayerKey(key("Escape"), plain.c);
    expect(plain.c.leave).toHaveBeenCalledOnce();
  });

  it("embeds only get the chrome keys", () => {
    const { c } = ctx({ isEmbed: true });
    handlePlayerKey(key("ArrowLeft"), c);
    handlePlayerKey(key("s"), c);
    expect(c.seek).not.toHaveBeenCalled();
    expect(c.setSheet).toHaveBeenCalled();
  });

  it("the shortcuts card swallows keys until closed", () => {
    const { c } = ctx({ keysOpen: true });
    handlePlayerKey(key(" "), c);
    handlePlayerKey(key("?"), c);
    expect(c.toggle).not.toHaveBeenCalled();
    expect(c.setKeysOpen).toHaveBeenCalledWith(false);
  });
});
