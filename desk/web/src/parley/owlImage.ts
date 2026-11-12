// The console owl drawn from the owner's finished mood art (public/img/owl-*.png), with the same API as owl.js.
// shortcut: still images per mood until the Rive rig lands; the rig replaces this file.
export type OwlMood = "idle" | "wave" | "talking" | "thinking" | "offer" | "fight" | "worried" | "warning" | "celebrate";

const MOODS: OwlMood[] = ["idle", "wave", "talking", "thinking", "offer", "fight", "worried", "warning", "celebrate"];
const REACT: Record<string, OwlMood> = { approve: "celebrate", skeptical: "worried", surprised: "warning", poke: "wave" };
// the open case's call sets the resting mood
const CALL: Record<string, OwlMood> = { offer: "offer", fight: "fight", accept: "worried" };

export function mountOwlImage(el: HTMLElement) {
  for (const m of MOODS) new Image().src = `/img/owl-${m}.png`; // preload so a mood change never flashes
  const img = document.createElement("img");
  img.alt = "";
  img.draggable = false;
  img.className = "owl-img";
  el.replaceChildren(img);
  let base: OwlMood = "idle";
  let talking = false;
  let busy = false; // thinking while the seller types
  let flash: ReturnType<typeof setTimeout> | undefined;
  const show = (m: OwlMood) => {
    const src = `/img/owl-${m}.png`;
    if (!img.src.endsWith(src)) img.src = src;
  };
  const rest = () => show(talking ? "talking" : busy ? "thinking" : base);
  const brief = (m: OwlMood, ms: number) => {
    clearTimeout(flash);
    show(m);
    flash = setTimeout(rest, ms);
  };
  const onMood = (e: Event) => {
    const call = (e as CustomEvent<{ call?: string | null }>).detail?.call;
    base = (call && CALL[call]) || "idle";
    rest();
  };
  addEventListener("parley:mood", onMood);
  rest();
  return {
    lookAt(x: number) {
      // a small lean toward the pointer
      const r = el.getBoundingClientRect();
      const d = Math.max(-1, Math.min(1, (x - (r.left + r.width / 2)) / 600));
      img.style.transform = `rotate(${(d * 4).toFixed(2)}deg)`;
    },
    play(n: string) {
      if (n === "arrive") brief("wave", 2200);
      else if (n === "notebook") { busy = true; rest(); }
      else if (n === "notebookAway") { busy = false; rest(); }
      else rest();
    },
    talk(on: boolean) {
      talking = on;
      clearTimeout(flash);
      rest();
    },
    react(n: string) {
      brief(REACT[n] ?? "wave", 1600);
    },
    destroy() {
      clearTimeout(flash);
      removeEventListener("parley:mood", onMood);
      el.replaceChildren();
    },
  };
}
