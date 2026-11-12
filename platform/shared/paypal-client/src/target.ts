export type PayPalEnv = "mock" | "sandbox" | "live";

export interface PayPalTarget {
  env: PayPalEnv;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

const DEFAULT_URL: Record<PayPalEnv, string> = {
  mock: "http://127.0.0.1:8080",
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

/**
 * Reads PAYPAL_ENV, PAYPAL_BASE_URL, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (and PAYPAL_ALLOW_LIVE).
 * PAYPAL_ENV defaults to sandbox when PAYPAL_CLIENT_ID is set and PAYPAL_BASE_URL is not; otherwise mock.
 * Errors name missing variables, never values.
 */
export function targetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PayPalTarget {
  const explicit = env["PAYPAL_ENV"];
  const kind: PayPalEnv =
    explicit === "mock" || explicit === "sandbox" || explicit === "live"
      ? explicit
      : explicit
        ? (() => {
            throw new Error(
              `PAYPAL_ENV must be mock, sandbox or live (got "${explicit}")`,
            );
          })()
        : env["PAYPAL_CLIENT_ID"] && !env["PAYPAL_BASE_URL"]
          ? "sandbox"
          : "mock";
  if (kind === "live" && env["PAYPAL_ALLOW_LIVE"] !== "1") {
    throw new Error("PAYPAL_ENV=live requires PAYPAL_ALLOW_LIVE=1");
  }
  const clientId =
    env["PAYPAL_CLIENT_ID"] || (kind === "mock" ? "mock-client" : "");
  const clientSecret =
    env["PAYPAL_CLIENT_SECRET"] || (kind === "mock" ? "mock-secret" : "");
  if (kind !== "mock") {
    const missing = [
      !clientId && "PAYPAL_CLIENT_ID",
      !clientSecret && "PAYPAL_CLIENT_SECRET",
    ].filter(Boolean);
    if (missing.length)
      throw new Error(`PAYPAL_ENV=${kind} needs ${missing.join(" and ")}`);
  }
  return {
    env: kind,
    baseUrl: (env["PAYPAL_BASE_URL"] || DEFAULT_URL[kind]).replace(/\/+$/, ""),
    clientId,
    clientSecret,
  };
}
