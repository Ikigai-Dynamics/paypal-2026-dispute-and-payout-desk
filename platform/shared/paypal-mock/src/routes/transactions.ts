import { invalid, route, type Route } from "../http.js";

const MAX_RANGE_MS = 31 * 86_400_000;

function date(v: string | null, field: string): number {
  if (!v)
    throw invalid("MISSING_REQUIRED_PARAMETER", `${field} is required`, field);
  const ms = Date.parse(v.replace(" ", "+"));
  if (Number.isNaN(ms))
    throw invalid(
      "INVALID_PARAMETER_VALUE",
      `${field} must be ISO-8601`,
      field,
    );
  return ms;
}

export const transactionRoutes: Route[] = [
  route("GET", "/v1/reporting/transactions", (ctx) => {
    const q = ctx.url.searchParams;
    const start = date(q.get("start_date"), "start_date");
    const end = date(q.get("end_date"), "end_date");
    if (end < start)
      throw invalid(
        "INVALID_PARAMETER_VALUE",
        "end_date must not precede start_date",
        "end_date",
      );
    if (end - start > MAX_RANGE_MS)
      throw invalid(
        "DATE_RANGE_TOO_LARGE",
        "The date range must not exceed 31 days",
        "end_date",
      ); // unverified
    const size = Math.min(
      500,
      Math.max(1, Number(q.get("page_size") ?? 100) || 100),
    );
    const page = Math.max(1, Number(q.get("page") ?? 1) || 1);
    ctx.state.settlePayouts();
    const id = q.get("transaction_id");
    const st = q.get("transaction_status");
    const amt = q.get("transaction_amount");
    const all = ctx.state.transactions.filter((t) => {
      const i = t.transaction_info;
      const when = Date.parse(i.transaction_initiation_date);
      return (
        when >= start &&
        when <= end &&
        (!id || i.transaction_id === id) &&
        (!st || i.transaction_status === st) &&
        (!amt || i.transaction_amount.value === amt)
      );
    });
    const base = `http://${ctx.host}/v1/reporting/transactions?${q.toString()}`;
    return {
      status: 200,
      body: {
        transaction_details: all.slice((page - 1) * size, page * size),
        account_number: "MOCKMERCHANT01",
        start_date: new Date(start).toISOString(),
        end_date: new Date(end).toISOString(),
        last_refreshed_datetime: new Date(ctx.state.config.now).toISOString(),
        page,
        total_items: all.length,
        total_pages: Math.max(1, Math.ceil(all.length / size)),
        links: [{ href: base, rel: "self", method: "GET" }],
      },
    };
  }),
];
