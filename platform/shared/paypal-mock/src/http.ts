import type { IncomingHttpHeaders } from "node:http";
import type {
  Link,
  PayPalErrorBody,
  PayPalErrorDetail,
} from "@jeirslab/paypal-client/types";
import type { MockState } from "./state.js";
import { randomUUID } from "node:crypto";

export class ApiError extends Error {
  constructor(
    public status: number,
    public errName: string,
    message: string,
    public details: PayPalErrorDetail[] = [],
  ) {
    super(message);
  }
}

export const notFound = (what: string, id: string) =>
  new ApiError(
    404,
    "RESOURCE_NOT_FOUND",
    "The specified resource does not exist.",
    [{ issue: "INVALID_RESOURCE_ID", description: `${what} ${id} not found` }],
  );

export const invalid = (issue: string, description: string, field?: string) =>
  new ApiError(
    400,
    "INVALID_REQUEST",
    "Request is not well-formed, syntactically incorrect, or violates schema.",
    [{ ...(field ? { field } : {}), issue, description }],
  );

export const unprocessable = (issue: string, description: string) =>
  new ApiError(
    422,
    "UNPROCESSABLE_ENTITY",
    "The requested action could not be performed, semantically incorrect, or failed business validation.",
    [{ issue, description }],
  );

export function errorBody(e: ApiError): PayPalErrorBody {
  const links: Link[] = [
    {
      href: "https://developer.paypal.com/api/rest/reference/orders/v2/errors/",
      rel: "information_link",
      method: "GET",
    },
  ];
  return {
    name: e.errName,
    message: e.message,
    debug_id: randomUUID().replaceAll("-", "").slice(0, 13),
    details: e.details,
    links,
  };
}

export interface Ctx {
  state: MockState;
  method: string;
  url: URL;
  params: Record<string, string>;
  headers: IncomingHttpHeaders;
  raw: Buffer;
  host: string;
  json<T = any>(): T;
  form(): URLSearchParams;
}

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (ctx: Ctx) => Reply;

export interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  /** requires a bearer token (when strict auth is on) and takes part in failure injection */
  api: boolean;
}

export function route(
  method: string,
  path: string,
  handler: Handler,
  api = true,
): Route {
  const keys: string[] = [];
  const src = path.replace(/:([a-z_]+)/g, (_m, k: string) => {
    keys.push(k);
    return "([^/]+)";
  });
  return { method, pattern: new RegExp(`^${src}$`), keys, handler, api };
}

export function selfLinks(ctx: Ctx, path: string, extra: Link[] = []): Link[] {
  return [
    { href: `http://${ctx.host}${path}`, rel: "self", method: "GET" },
    ...extra,
  ];
}
