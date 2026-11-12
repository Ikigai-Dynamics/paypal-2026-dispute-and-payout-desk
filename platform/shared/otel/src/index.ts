import { SpanStatusCode, trace } from "@opentelemetry/api";

export interface TracingHandle {
  /** false when OTEL_SDK_DISABLED=true or no endpoint is configured (spans are then no-ops). */
  readonly enabled: boolean;
  /** Flush and stop the SDK; call it from the SIGTERM handler. */
  shutdown(): Promise<void>;
}

/**
 * One call per service, before it serves traffic: `const otel = await startTracing()`.
 * Exports traces, metrics and logs over OTLP to OTEL_EXPORTER_OTLP_ENDPOINT (the platform
 * injects http://otel-collector:4318 when platform.otel.enable is set). The service name is
 * OTEL_SERVICE_NAME (the platform sets it). Without an endpoint, or with OTEL_SDK_DISABLED=true,
 * nothing starts and every span is a no-op, so tests and local runs need no collector.
 */
export async function startTracing(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TracingHandle> {
  const disabled = env["OTEL_SDK_DISABLED"] === "true";
  const endpoint =
    env["OTEL_EXPORTER_OTLP_ENDPOINT"] ??
    env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"];
  if (disabled || !endpoint) {
    return { enabled: false, shutdown: async () => {} };
  }
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const sdk = new NodeSDK();
  sdk.start();
  return {
    enabled: true,
    shutdown: async () => {
      try {
        await sdk.shutdown();
      } catch {
        /* the collector may already be gone at shutdown */
      }
    },
  };
}

/** Run fn inside a span named `name`; records an exception and marks the span as an error on throw. */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T> | T,
  attributes: Record<string, string | number | boolean> = {},
): Promise<T> {
  return trace
    .getTracer("@jeirslab/otel")
    .startActiveSpan(name, { attributes }, async (span) => {
      try {
        return await fn();
      } catch (e) {
        span.recordException(e instanceof Error ? e : new Error(String(e)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw e;
      } finally {
        span.end();
      }
    });
}
