// Official @paypal/paypal-server-sdk path, used for sandbox and live only. The SDK
// has no custom base URL (Environment is Production | Sandbox), so the mock goes through fetch.
// SDK models are camelCase; we convert to the REST (snake_case) shapes in types.ts.
import { toCamel, toSnake } from "./casing.js";
import { PayPalApiError } from "./errors.js";
import type { PayPalTarget } from "./target.js";
import type {
  CreateOrderRequest,
  Order,
  TransactionSearchQuery,
  TransactionSearchResponse,
} from "./types.js";

type Loose = Record<string, any>;

export interface SdkClient {
  createOrder(b: CreateOrderRequest, requestId: string): Promise<Order>;
  getOrder(id: string): Promise<Order>;
  captureOrder(id: string, requestId: string): Promise<Order>;
  searchTransactions(
    q: TransactionSearchQuery,
  ): Promise<TransactionSearchResponse>;
}

export async function createSdkClient(
  target: PayPalTarget,
  timeoutMs: number,
): Promise<SdkClient> {
  const sdk = await import("@paypal/paypal-server-sdk");
  const client = new sdk.Client({
    timeout: timeoutMs,
    environment:
      target.env === "live"
        ? sdk.Environment.Production
        : sdk.Environment.Sandbox,
    clientCredentialsAuthCredentials: {
      oAuthClientId: target.clientId,
      oAuthClientSecret: target.clientSecret,
    },
  });
  const orders = new sdk.OrdersController(client);
  const search = new sdk.TransactionSearchController(client);

  async function run<T>(f: () => Promise<{ result: unknown }>): Promise<T> {
    try {
      return toSnake<T>((await f()).result);
    } catch (e) {
      const err = e as {
        statusCode?: number;
        result?: Loose;
        message?: string;
      };
      if (typeof err.statusCode === "number") {
        throw new PayPalApiError(err.statusCode, {
          ...(toSnake<Loose>(err.result ?? {}) as object),
          message:
            (err.result as Loose | undefined)?.["message"] ?? err.message,
        });
      }
      throw e;
    }
  }

  return {
    createOrder: (b, requestId) =>
      run<Order>(() =>
        orders.createOrder({
          body: toCamel<Loose>(b) as never,
          paypalRequestId: requestId,
          prefer: "return=representation",
        }),
      ),
    getOrder: (id) => run<Order>(() => orders.getOrder({ id })),
    captureOrder: (id, requestId) =>
      run<Order>(() =>
        orders.captureOrder({
          id,
          paypalRequestId: requestId,
          prefer: "return=representation",
        }),
      ),
    searchTransactions: (q) =>
      run<TransactionSearchResponse>(() =>
        search.searchTransactions({
          startDate: q.start_date,
          endDate: q.end_date,
          ...(q.transaction_id ? { transactionId: q.transaction_id } : {}),
          ...(q.transaction_status
            ? { transactionStatus: q.transaction_status }
            : {}),
          ...(q.transaction_amount
            ? { transactionAmount: q.transaction_amount }
            : {}),
          ...(q.page_size ? { pageSize: q.page_size } : {}),
          ...(q.page ? { page: q.page } : {}),
          ...(q.fields ? { fields: q.fields } : {}),
        }),
      ),
  };
}
