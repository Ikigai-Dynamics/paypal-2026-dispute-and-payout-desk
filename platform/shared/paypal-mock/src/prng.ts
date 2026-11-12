// mulberry32: small, fast, deterministic. Never use Math.random in seeding.
export class Prng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)] as T;
  }
  weighted<T>(xs: readonly (readonly [T, number])[]): T {
    const total = xs.reduce((a, [, w]) => a + w, 0);
    let r = this.next() * total;
    for (const [x, w] of xs) {
      r -= w;
      if (r < 0) return x;
    }
    return xs[xs.length - 1]![0];
  }
  id(len: number, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"): string {
    let out = "";
    for (let i = 0; i < len; i++)
      out += alphabet[Math.floor(this.next() * alphabet.length)];
    return out;
  }
}
