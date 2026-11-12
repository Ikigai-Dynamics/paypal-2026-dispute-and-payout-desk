import { useEffect, useRef, useState } from "react";
import { POKES } from "./lines";

type OwlApi = {
  lookAt(x: number, y: number): void;
  play(n: string): void;
  talk(on: boolean): void;
  react(n: string): void;
  destroy?(): void;
};
declare global {
  interface Window {
    ParleyOwl?: { mount(el: HTMLElement): OwlApi };
  }
}
const NOOP: OwlApi = { lookAt() {}, play() {}, talk() {}, react() {} };

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The corner companion: owl.js on a canvas plus a speech bubble. `speech` is what to say next (seq makes a repeat count). */
export function Owl({ speech, tucked }: { speech: { text: string; seq: number } | null; tucked: boolean }) {
  const owlEl = useRef<HTMLDivElement>(null);
  const sayEl = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const owl = useRef<OwlApi>(NOOP);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const last = useRef("");
  const audio = useRef<AudioContext | null>(null);
  const [voice, setVoice] = useState(false);
  const voiceRef = useRef(false);
  voiceRef.current = voice;
  const poke = useRef(0);
  const click = useRef<ReturnType<typeof setTimeout>>();
  const fade = useRef<ReturnType<typeof setTimeout>>();
  const [faded, setFaded] = useState(false);
  // the bubble fades 8 s after a line is finished; clicking the owl brings it back
  const armFade = () => {
    clearTimeout(fade.current);
    fade.current = setTimeout(() => setFaded(true), 8000);
  };

  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function blip(ch: string, force = false) {
    const ac = audio.current;
    if (!voiceRef.current || !ac || (!force && !/[a-z0-9]/i.test(ch))) return;
    try {
      const t = ac.currentTime,
        o = ac.createOscillator(),
        g = ac.createGain(),
        n = ch.toLowerCase().charCodeAt(0) % 12;
      o.type = "square";
      o.frequency.setValueAtTime(330 + n * 26, t);
      o.frequency.exponentialRampToValueAtTime(240 + n * 20, t + 0.06);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.04, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      o.connect(g).connect(ac.destination);
      o.start(t);
      o.stop(t + 0.08);
    } catch {}
  }

  // typewriter; **bold** marks money
  function speak(text: string) {
    const el = sayEl.current;
    if (!el) return;
    last.current = text;
    clearTimeout(timer.current);
    clearTimeout(fade.current);
    setFaded(false);
    const tokens: [string, boolean][] = [];
    text.split(/(\*\*[^*]+\*\*)/).forEach((p) => {
      const b = p.startsWith("**");
      [...(b ? p.slice(2, -2) : p)].forEach((c) => tokens.push([c, b]));
    });
    const render = (n: number) => {
      let out = "",
        open = false;
      for (let k = 0; k < n; k++) {
        const [c, b] = tokens[k]!;
        if (b !== open) {
          out += b ? "<b>" : "</b>";
          open = b;
        }
        out += esc(c);
      }
      return out + (open ? "</b>" : "");
    };
    let i = 0;
    owl.current.talk(true);
    const step = () => {
      if (i >= tokens.length) {
        el.innerHTML = render(i);
        owl.current.talk(false);
        armFade();
        return;
      }
      const [c] = tokens[i++]!;
      if (i % 2) blip(c);
      el.innerHTML = render(i) + '<span class="caret"></span>';
      timer.current = setTimeout(step, reduce ? 0 : /[.,?!]/.test(c) ? 170 : 24);
    };
    step();
  }
  const speakRef = useRef(speak);
  speakRef.current = speak;

  useEffect(() => {
    if (tucked || !owlEl.current) return;
    owl.current = window.ParleyOwl ? window.ParleyOwl.mount(owlEl.current) : NOOP;
    const o = owl.current;
    let notes = false;
    const move = (e: PointerEvent) => o.lookAt(e.clientX, e.clientY);
    const typing = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (!notes && (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA")) {
        notes = true;
        o.play("notebook");
      }
    };
    const stop = () => {
      if (notes) {
        notes = false;
        o.play("notebookAway");
      }
    };
    const onSay = (e: Event) => {
      const t = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (t) speakRef.current(String(t));
    };
    addEventListener("pointermove", move);
    document.addEventListener("input", typing);
    document.addEventListener("focusout", stop);
    addEventListener("parley:say", onSay);
    if (last.current) speakRef.current(last.current);
    return () => {
      removeEventListener("pointermove", move);
      document.removeEventListener("input", typing);
      document.removeEventListener("focusout", stop);
      removeEventListener("parley:say", onSay);
      clearTimeout(timer.current);
      clearTimeout(fade.current);
      try {
        o.destroy?.();
      } catch {}
      owl.current = NOOP;
    };
  }, [tucked]);

  useEffect(() => {
    if (speech && !tucked) {
      owl.current.play("arrive");
      speakRef.current(speech.text);
    } else if (speech) last.current = speech.text;
  }, [speech?.seq]);

  // the page keeps its bottom padding equal to the companion's height, so nothing hides under it
  useEffect(() => {
    const root = document.documentElement;
    document.body.classList.toggle("tucked", tucked);
    if (tucked || !bar.current || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => root.style.setProperty("--dock", `${bar.current?.offsetHeight ?? 0}px`));
    ro.observe(bar.current);
    return () => ro.disconnect();
  }, [tucked]);

  if (tucked) return null;
  return (
    <div className="companion" ref={bar}>
      <div className={"bubble" + (faded ? " faded" : "")} id="bubble" aria-hidden={faded}>
        <div className="who">
          <span>Parley</span>
          <span className="acts">
            <button type="button" aria-label="Say it again" onClick={() => speak(last.current)}>
              ↻ again
            </button>
            <button
              type="button"
              aria-pressed={voice}
              onClick={() => {
                const on = !voice;
                if (on && !audio.current) {
                  try {
                    audio.current = new (window.AudioContext || (window as any).webkitAudioContext)();
                  } catch {
                    return;
                  }
                }
                voiceRef.current = on;
                setVoice(on);
                if (on) blip("h", true);
              }}
            >
              {voice ? "🔊 voice" : "🔈 voice"}
            </button>
          </span>
        </div>
        <div id="say" ref={sayEl} aria-live="polite" />
      </div>
      <div className="owlbox">
      <div
        id="owl"
        ref={owlEl}
        role="img"
        aria-label="Parley the owl. Click to chat; double-click to poke."
        onClick={() => {
          // a double-click is a poke, not two chat openings
          clearTimeout(click.current);
          if (faded) {
            setFaded(false);
            armFade();
          }
          click.current = setTimeout(() => {
            owl.current.play("arrive");
            window.dispatchEvent(new CustomEvent("parley:open-chat"));
          }, 260);
        }}
        onDoubleClick={() => {
          clearTimeout(click.current);
          owl.current.react("poke");
          speak(POKES[poke.current++ % POKES.length]!);
        }}
      />
      <button
        type="button"
        className="talk-pill"
        onClick={() => {
          owl.current.play("arrive");
          window.dispatchEvent(new CustomEvent("parley:open-chat"));
        }}
      >
        Talk to Parley
      </button>
      </div>
    </div>
  );
}
