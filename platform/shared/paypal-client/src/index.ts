import { randomUUID } from "node:crypto";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { PayPalApiError } from "./errors.js";
import { createSdkClient, type SdkClient } from "./sdk.js";
import { targetFromEnv, type PayPalTarget } from "./target.js";
import type {
  AcceptClaimRequest,
  MakeOfferRequest,
  CreateOrderRequest,
  CreatePayoutRequest,
  CreatePayoutResponse,
  Dispute,
  DisputeList,
  Evidence,
  LinksResponse,
  ListDisputesQuery,
  Order,
  PayoutBatch,
  PayoutItem,
  TransactionSearchQuery,
  TransactionSearchResponse,
} from "./types.js";

export { PayPalApiError } from "./errors.js";
export { targetFromEnv } from "./target.js";
export type { PayPalEnv, PayPalTarget } from "./target.js";
export * from "./types.js";

export interface ClientOptions extends Partial<PayPalTarget> {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  logger?: (e: { op: string; status?: number; ms: number }) => void;
}

export interface PayPalClient {
  readonly target: PayPalTarget;
  getAccessToken(): Promise<string>;
  orders: {
    create(b: CreateOrderRequest, o?: { requestId?: string }): Promise<Order>;
    get(id: string): Promise<Order>;
    capture(id: string, o?: { requestId?: string }): Promise<Order>;
  };
  payouts: {
    create(
      b: CreatePayoutRequest,
      o?: { requestId?: string },
    ): Promise<CreatePayoutResponse>;
    get(
      batchId: string,
      q?: { page?: number; pageSize?: number },
    ): Promise<PayoutBatch>;
    getItem(itemId: string): Promise<PayoutItem>;
  };
  disputes: {
    list(q?: ListDisputesQuery): Promise<DisputeList>;
    get(id: string): Promise<Dispute>;
    provideEvidence(
      id: string,
      b: {
        evidences: Evidence[];
        files?: { name: string; contentType: string; data: Uint8Array }[];
      },
      o?: { requestId?: string },
    ): Promise<LinksResponse>;
    acceptClaim(
      id: string,
      b: AcceptClaimRequest,
      o?: { requestId?: string },
    ): Promise<LinksResponse>;
    makeOffer(
      id: string,
      b: MakeOfferRequest,
      o?: { requestId?: string },
    ): Promise<LinksResponse>;
  };
  transactions: {
    search(q: TransactionSearchQuery): Promise<TransactionSearchResponse>;
  };
}

const BACKOFF_MS = [100, 400, 1600];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tracer = trace.getTracer("@jeirslab/paypal-client");

interface Req {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  form?: FormData;
  requestId?: string;
}

export function createPayPalClient(opts: ClientOptions = {}): PayPalClient {
  const base = targetFromEnv();
  const target: PayPalTarget = {
    env: opts.env ?? base.env,
    baseUrl: (opts.baseUrl ?? base.baseUrl).replace(/\/+$/, ""),
    clientId: opts.clientId ?? base.clientId,
    clientSecret: opts.clientSecret ?? base.clientSecret,
  };
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxRetries = opts.maxRetries ?? 3;
  const log = opts.logger;

  let token: { value: string; exp: number } | undefined;
  let sdk: Promise<SdkClient> | undefined;
  const useSdk = target.env !== "mock" && !opts.fetch;
  const getSdk = () => (sdk ??= createSdkClient(target, timeoutMs));

  async function getAccessToken(): Promise<string> {
    if (token && token.exp - 60_000 > Date.now()) return token.value;
    const res = await doFetch(`${target.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${target.clientId}:${target.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!res.ok || !body.access_token)
      throw new PayPalApiError(res.status, body as never);
    token = {
      value: body.access_token,
      exp: Date.now() + (body.expires_in ?? 300) * 1000,
    };
    return token.value;
  }

  async function request<T>(req: Req, retried401 = false): Promise<T> {
    const url = new URL(`${target.baseUrl}${req.path}`);
    for (const [k, v] of Object.entries(req.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const idempotent = req.method === "GET" || req.requestId !== undefined;
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      let netErr: unknown;
      try {
        res = await doFetch(url, {
          method: req.method,
          headers: {
            authorization: `Bearer ${await getAccessToken()}`,
            ...(req.json !== undefined
              ? { "content-type": "application/json" }
              : {}),
            ...(req.requestId ? { "paypal-request-id": req.requestId } : {}),
          },
          ...(req.json !== undefined ? { body: JSON.stringify(req.json) } : {}),
          ...(req.form ? { body: req.form } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        netErr = e;
      }
      if (res?.status === 401 && !retried401) {
        token = undefined;
        return request<T>(req, true);
      }
      const retryable =
        netErr !== undefined ||
        (res !== undefined && (res.status === 429 || res.status >= 500));
      if (
        retryable &&
        idempotent &&
        attempt < Math.min(maxRetries, BACKOFF_MS.length)
      ) {
        await sleep(BACKOFF_MS[attempt]!);
        continue;
      }
      if (!res) throw netErr;
      const text = await res.text();
      const body = text ? (JSON.parse(text) as unknown) : {};
      if (!res.ok) throw new PayPalApiError(res.status, body as never);
      return body as T;
    }
  }

  async function traced<T>(
    area: string,
    op: string,
    f: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    return tracer.startActiveSpan(`paypal.${area}.${op}`, async (span) => {
      try {
        const out = await f();
        log?.({ op: `${area}.${op}`, status: 200, ms: Date.now() - started });
        return out;
      } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        log?.({
          op: `${area}.${op}`,
          ...(e instanceof PayPalApiError ? { status: e.status } : {}),
          ms: Date.now() - started,
        });
        throw e;
      } finally {
        span.end();
      }
    });
  }

  const rid = (o?: { requestId?: string }) => o?.requestId ?? randomUUID();

  return {
    target,
    getAccessToken,
    orders: {
      create: (b, o) =>
        traced("orders", "create", async () =>
          useSdk
            ? (await getSdk()).createOrder(b, rid(o))
            : request<Order>({
                method: "POST",
                path: "/v2/checkout/orders",
                json: b,
                requestId: rid(o),
              }),
        ),
      get: (id) =>
        traced("orders", "get", async () =>
          useSdk
            ? (await getSdk()).getOrder(id)
            : request<Order>({
                method: "GET",
                path: `/v2/checkout/orders/${encodeURIComponent(id)}`,
              }),
        ),
      capture: (id, o) =>
        traced("orders", "capture", async () =>
          useSdk
            ? (await getSdk()).captureOrder(id, rid(o))
            : request<Order>({
                method: "POST",
                path: `/v2/checkout/orders/${encodeURIComponent(id)}/capture`,
                json: {},
                requestId: rid(o),
              }),
        ),
    },
    payouts: {
      create: (b, o) =>
        traced("payouts", "create", () =>
          request<CreatePayoutResponse>({
            method: "POST",
            path: "/v1/payments/payouts",
            json: b,
            requestId: rid(o),
          }),
        ),
      get: (id, q) =>
        traced("payouts", "get", () =>
          request<PayoutBatch>({
            method: "GET",
            path: `/v1/payments/payouts/${encodeURIComponent(id)}`,
            query: { page: q?.page, page_size: q?.pageSize },
          }),
        ),
      getItem: (id) =>
        traced("payouts", "getItem", () =>
          request<PayoutItem>({
            method: "GET",
            path: `/v1/payments/payouts-item/${encodeURIComponent(id)}`,
          }),
        ),
    },
    disputes: {
      list: (q) =>
        traced("disputes", "list", () =>
          request<DisputeList>({
            method: "GET",
            path: "/v1/customer/disputes",
            query: { ...q },
          }),
        ),
      get: (id) =>
        traced("disputes", "get", () =>
          request<Dispute>({
            method: "GET",
            path: `/v1/customer/disputes/${encodeURIComponent(id)}`,
          }),
        ),
      provideEvidence: (id, b, o) =>
        traced("disputes", "provideEvidence", () => {
          const path = `/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`;
          if (!b.files?.length)
            return request<LinksResponse>({
              method: "POST",
              path,
              json: { evidences: b.evidences },
              requestId: rid(o),
            });
          const form = new FormData();
          form.set(
            "input",
            new Blob([JSON.stringify({ evidences: b.evidences })], {
              type: "application/json",
            }),
            "input.json",
          );
          for (const f of b.files)
            form.append(
              "file",
              new Blob([f.data as never], { type: f.contentType }),
              f.name,
            );
          return request<LinksResponse>({
            method: "POST",
            path,
            form,
            requestId: rid(o),
          });
        }),
      acceptClaim: (id, b, o) =>
        traced("disputes", "acceptClaim", () =>
          request<LinksResponse>({
            method: "POST",
            path: `/v1/customer/disputes/${encodeURIComponent(id)}/accept-claim`,
            json: b,
            requestId: rid(o),
          }),
        ),
      makeOffer: (id, b, o) =>
        traced("disputes", "makeOffer", () =>
          request<LinksResponse>({
            method: "POST",
            path: `/v1/customer/disputes/${encodeURIComponent(id)}/make-offer`,
            json: b,
            requestId: rid(o),
          }),
        ),
    },
    transactions: {
      search: (q) =>
        traced("transactions", "search", async () =>
          useSdk
            ? (await getSdk()).searchTransactions(q)
            : request<TransactionSearchResponse>({
                method: "GET",
                path: "/v1/reporting/transactions",
                query: { ...q },
              }),
        ),
    },
  };
}
