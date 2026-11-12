import { route, type Route } from "../http.js";

export const adminRoutes: Route[] = [
  route(
    "GET",
    "/healthz",
    () => ({ status: 200, body: { status: "ok" } }),
    false,
  ),
  route(
    "GET",
    "/readyz",
    () => ({ status: 200, body: { status: "ready" } }),
    false,
  ),
  route(
    "GET",
    "/mock/state",
    (ctx) => ({ status: 200, body: ctx.state.counts() }),
    false,
  ),
  // the shared story: merchant, catalog and buyers of the loaded dataset (404 when the generator seeded)
  route(
    "GET",
    "/mock/dataset",
    (ctx) =>
      ctx.state.dataset
        ? { status: 200, body: ctx.state.dataset }
        : {
            status: 404,
            body: { name: "NOT_FOUND", message: "no dataset loaded" },
          },
    false,
  ),
  route(
    "POST",
    "/mock/reset",
    (ctx) => {
      const b = ctx.raw.length ? ctx.json<{ seed?: number }>() : {};
      ctx.state.reseed(typeof b.seed === "number" ? b.seed : undefined);
      return { status: 200, body: ctx.state.counts() };
    },
    false,
  ),
];
