import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { App } from "./App";

// the grid and the case page have their own tests; here only the banners matter
vi.mock("./components/AllCases", () => ({ AllCases: () => null }));
vi.mock("./case/CasePage", () => ({ CasePage: () => <div>case page</div> }));

const UNREACHABLE = /PayPal is unreachable right now/;
const RESET = /The desk was reset since you opened this page/;

function stub(infos: object[]) {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.startsWith("/api/info")
        ? infos[Math.min(i++, infos.length - 1)]
        : url.startsWith("/api/cases")
          ? { cases: [] }
          : { calls: [] };
      return { ok: true, status: 200, json: async () => body };
    }),
  );
}
const info = (bootId: string, error: string | null = null) => ({
  bootId,
  paypalEnv: "mock",
  llm: { online: false },
  sync: { error },
});
const settle = () => act(async () => {});

describe("App banners", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    location.hash = "";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    location.hash = "";
  });

  it("shows neither banner on a normal load", async () => {
    stub([info("a")]);
    render(<App />);
    await settle();
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    expect(screen.queryByText(RESET)).toBeNull();
  });

  it("shows the unreachable banner when the sync failed", async () => {
    stub([info("a", "ECONNREFUSED")]);
    render(<App />);
    await settle();
    expect(screen.getByText(UNREACHABLE)).toBeInTheDocument();
  });

  it("shows the reset banner when the boot id changes under an open case", async () => {
    location.hash = "case=X";
    stub([info("a"), info("b")]);
    render(<App />);
    await settle();
    expect(screen.queryByText(RESET)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByText(RESET)).toBeInTheDocument();
  });
});
