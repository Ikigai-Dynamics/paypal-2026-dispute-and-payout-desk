import { ApiError, route, type Route } from "../http.js";

const TOKEN_TTL_S = 32400;

export function issueToken(clientId: string, nowMs = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({
      cid: clientId,
      exp: Math.floor(nowMs / 1000) + TOKEN_TTL_S,
    }),
  ).toString("base64url");
  return `A21AA${payload}`;
}

/** Stateless: survives pod restarts. Returns the client id when valid. */
export function verifyToken(
  header: string | undefined,
  nowMs = Date.now(),
): string | null {
  const m = /^Bearer (A21AA[A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!m) return null;
  try {
    const p = JSON.parse(
      Buffer.from(m[1]!.slice(5), "base64url").toString("utf8"),
    ) as { cid?: string; exp?: number };
    if (
      typeof p.cid !== "string" ||
      typeof p.exp !== "number" ||
      p.exp * 1000 <= nowMs
    )
      return null;
    return p.cid;
  } catch {
    return null;
  }
}

export const oauthRoutes: Route[] = [
  route(
    "POST",
    "/v1/oauth2/token",
    (ctx) => {
      const m = /^Basic (.+)$/.exec(String(ctx.headers["authorization"] ?? ""));
      const decoded = m ? Buffer.from(m[1]!, "base64").toString("utf8") : "";
      const i = decoded.indexOf(":");
      const id = i > 0 ? decoded.slice(0, i) : "";
      const secret = i > 0 ? decoded.slice(i + 1) : "";
      if (!id || !secret) {
        return {
          status: 401,
          body: {
            error: "invalid_client",
            error_description: "Client Authentication failed",
          },
        };
      }
      if (ctx.form().get("grant_type") !== "client_credentials") {
        return {
          status: 400,
          body: {
            error: "unsupported_grant_type",
            error_description: "Grant Type is NULL",
          },
        };
      }
      return {
        status: 200,
        body: {
          scope:
            "https://uri.paypal.com/services/payments/payment https://uri.paypal.com/services/payments/payouts https://uri.paypal.com/services/reporting/search/read https://uri.paypal.com/services/disputes/read-seller https://uri.paypal.com/services/disputes/update-seller",
          access_token: issueToken(id),
          token_type: "Bearer",
          app_id: "APP-MOCK",
          expires_in: TOKEN_TTL_S,
          nonce: `${new Date().toISOString()}mock`,
        },
      };
    },
    false,
  ),
];

export { ApiError };
