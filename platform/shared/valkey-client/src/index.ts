import { Redis as Valkey } from "iovalkey";

export type { Valkey };

const COMMON = {
  lazyConnect: false,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 2000,
};

/**
 * Valkey through Sentinel (HA) when VALKEY_SENTINELS ("host:port,host:port") is set,
 * a plain URL otherwise (VALKEY_URL, default redis://valkey:6379). Error events are
 * swallowed: failures show up per request, never as a crash during a failover.
 */
export function makeValkey(env: NodeJS.ProcessEnv = process.env): Valkey {
  const sentinels = env["VALKEY_SENTINELS"];
  const client = sentinels
    ? new Valkey({
        ...COMMON,
        sentinels: sentinels.split(",").map((s) => {
          const [host, p] = s.trim().split(":");
          return { host: host ?? "valkey-sentinel", port: Number(p ?? 26379) };
        }),
        name: env["VALKEY_MASTER_NAME"] ?? "mymaster",
      })
    : new Valkey(env["VALKEY_URL"] ?? "redis://valkey:6379", COMMON);
  client.on("error", () => {
    /* reported per request; never crash on a valkey failover */
  });
  return client;
}

/** makeValkey when VALKEY_SENTINELS or VALKEY_URL is set, otherwise undefined. */
export function createValkey(
  env: NodeJS.ProcessEnv = process.env,
): Valkey | undefined {
  return env["VALKEY_SENTINELS"] || env["VALKEY_URL"]
    ? makeValkey(env)
    : undefined;
}
