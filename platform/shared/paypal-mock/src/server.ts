import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";
import {
  ApiError,
  errorBody,
  unprocessable,
  type Ctx,
  type Reply,
  type Route,
} from "./http.js";
import { loadConfig, MockState, type MockConfig } from "./state.js";
import { adminRoutes } from "./routes/admin.js";
import { authorizationRoutes } from "./routes/authorizations.js";
import { disputeRoutes } from "./routes/disputes.js";
import { oauthRoutes, verifyToken } from "./routes/oauth.js";
import { orderRoutes } from "./routes/orders.js";
import { payoutRoutes } from "./routes/payouts.js";
import { transactionRoutes } from "./routes/transactions.js";

export { loadConfig, MockState } from "./state.js";
export type { MockConfig } from "./state.js";

const ROUTES: Route[] = [
  ...adminRoutes,
  ...oauthRoutes,
  ...orderRoutes,
  ...authorizationRoutes,
  ...payoutRoutes,
  ...disputeRoutes,
  ...transactionRoutes,
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export interface MockServer {
  server: Server;
  state: MockState;
  /** resolves with the bound port */
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export function createMockServer(
  overrides: Partial<MockConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): MockServer {
  const config = { ...loadConfig(env), ...overrides };
  const state = new MockState(config);

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const started = Date.now();
    const requestId = String(req.headers["paypal-request-id"] ?? randomUUID());
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    let reply: Reply;
    try {
      if (config.latencyMs > 0) await sleep(config.latencyMs);
      const raw = await readBody(req);
      const hit = ROUTES.map((r) => ({
        r,
        m: r.method === method ? r.pattern.exec(url.pathname) : null,
      })).find((x) => x.m);
      if (!hit || !hit.m)
        throw new ApiError(
          404,
          "RESOURCE_NOT_FOUND",
          "The specified resource does not exist.",
          [
            {
              issue: "INVALID_RESOURCE_ID",
              description: `${method} ${url.pathname} is not a mock route`,
            },
          ],
        );
      const params: Record<string, string> = {};
      hit.r.keys.forEach(
        (k, i) => (params[k] = decodeURIComponent(hit.m![i + 1]!)),
      );
      const ctx: Ctx = {
        state,
        method,
        url,
        params,
        headers: req.headers,
        raw,
        host: String(req.headers["host"] ?? "localhost"),
        json<T>() {
          try {
            return JSON.parse(raw.toString("utf8") || "{}") as T;
          } catch {
            throw new ApiError(
              400,
              "INVALID_REQUEST",
              "Request is not well-formed, syntactically incorrect, or violates schema.",
              [
                {
                  issue: "MALFORMED_REQUEST_JSON",
                  description: "The request body is not valid JSON",
                },
              ],
            );
          }
        },
        form: () => new URLSearchParams(raw.toString("utf8")),
      };
      if (hit.r.api) {
        if (
          config.strictAuth &&
          !verifyToken(String(req.headers["authorization"] ?? ""))
        ) {
          throw new ApiError(
            401,
            "invalid_token",
            "Token signature verification failed",
          );
        }
        state.requestCount++;
        if (
          config.failureEvery > 0 &&
          state.requestCount % config.failureEvery === 0
        ) {
          throw new ApiError(
            500,
            "INTERNAL_SERVER_ERROR",
            "An internal service error has occurred.",
          );
        }
      }
      // idempotency: same PayPal-Request-Id on the same POST route replays the stored reply
      const rid =
        method === "POST" && hit.r.api
          ? req.headers["paypal-request-id"]
          : undefined;
      const idemKey = rid ? `${url.pathname}\u0000${String(rid)}` : undefined;
      const stored = idemKey ? state.idempotency.get(idemKey) : undefined;
      if (stored) {
        reply = { status: stored.status, body: stored.body };
      } else {
        const neg =
          method === "POST" && hit.r.api
            ? req.headers["paypal-mock-response"]
            : undefined;
        if (neg) {
          let code: string | undefined;
          try {
            code = (
              JSON.parse(String(neg)) as { mock_application_codes?: string }
            ).mock_application_codes;
          } catch {
            /* ignore malformed header */
          }
          if (code)
            throw unprocessable(
              code,
              `Simulated by PayPal-Mock-Response: ${code}`,
            );
        }
        reply = hit.r.handler(ctx);
        if (idemKey)
          state.idempotency.set(idemKey, {
            status: reply.status,
            body: reply.body,
          });
      }
    } catch (e) {
      if (e instanceof ApiError) {
        reply = {
          status: e.status,
          body:
            e.errName === "invalid_token"
              ? { error: "invalid_token", error_description: e.message }
              : errorBody(e),
        };
      } else {
        reply = {
          status: 500,
          body: errorBody(
            new ApiError(
              500,
              "INTERNAL_SERVER_ERROR",
              "An internal service error has occurred.",
            ),
          ),
        };
      }
    }
    const payload = reply.body === undefined ? "" : JSON.stringify(reply.body);
    res.writeHead(reply.status, {
      "content-type": "application/json",
      "paypal-debug-id": requestId.replaceAll("-", "").slice(0, 13),
      ...reply.headers,
    });
    res.end(payload);
    if (config.log) {
      process.stdout.write(
        `${JSON.stringify({ ts: new Date().toISOString(), method, path: url.pathname, status: reply.status, ms: Date.now() - started, request_id: requestId })}\n`,
      );
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  return {
    server,
    state,
    listen: (port = config.port, host = config.host) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const a = server.address();
          resolve(typeof a === "object" && a ? a.port : port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function isMain(): boolean {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(process.argv[1]) ===
        realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMain()) {
  const mock = createMockServer();
  const port = await mock.listen();
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), msg: "paypal-mock listening", port, seed: mock.state.config.seed })}\n`,
  );
  // SIGTERM: stop accepting, drain in-flight requests, exit.
  const stop = () => {
    mock.server.close(() => process.exit(0));
    mock.server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
