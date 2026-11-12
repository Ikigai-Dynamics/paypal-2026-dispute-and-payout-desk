export interface LlmRequest {
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmResult<T> {
  value: T | string;
  source: "llm" | "fallback";
  /** what to show next to the output: "AI (<model>)" or "offline fallback"; never an env var name */
  label: string;
  model?: string;
  error?: string;
  /** tokens and simulated cost of this call; a fallback costs nothing */
  usage?: LlmUsage;
}

/** What one call would cost at PayPal's AI partner's list price (we run on a lab proxy, so the cost is simulated). */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** the model whose price was used, e.g. "openai/gpt-5" */
  pricedAs: string;
  /** true when the proxy returned no usage and tokens were estimated from text length */
  estimated: boolean;
}

export interface LlmSpend {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  pricedAs: string;
}

// USD per million tokens [input, output], list prices as of 2025-08 (openai.com/api/pricing, ai.google.dev/pricing).
// PayPal's main AI partner is OpenAI (ChatGPT Enterprise, APIs, Instant Checkout, 2025-10); Google Cloud (Vertex AI) is the other.
// shortcut: hand-copied price table, update it when the providers change their prices.
export const PRICES: Record<string, [number, number]> = {
  "openai/gpt-5": [1.25, 10],
  "openai/gpt-5-mini": [0.25, 2],
  "google/gemini-2.5-pro": [1.25, 10],
  "google/gemini-2.5-flash": [0.3, 2.5],
};
export const DEFAULT_PRICED_AS = "openai/gpt-5";

/** about 4 characters per token for English text */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export function priceUsd(
  pricedAs: string,
  input: number,
  output: number,
): number {
  const [i, o] = PRICES[pricedAs] ?? PRICES[DEFAULT_PRICED_AS]!;
  return (input * i + output * o) / 1e6;
}

export interface Llm {
  /** true when LLM_BASE_URL, LLM_API_KEY and LLM_MODEL are all set */
  readonly online: boolean;
  /** the configured model, when online */
  readonly model?: string;
  complete<T = string>(
    req: LlmRequest,
    fallback: () => T | Promise<T>,
  ): Promise<LlmResult<T>>;
  /** running total of every call since start */
  spend(): LlmSpend;
}

/** The JSON object in a model reply: Claude often wraps it in a ```json fence or adds a sentence around it. */
export function jsonText(content: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
  const body = (fenced ? fenced[1]! : content).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

export function createLlm(
  opts: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    fetch?: typeof fetch;
  } = {},
): Llm {
  const env = opts.env ?? process.env;
  const base = env["LLM_BASE_URL"];
  const key = env["LLM_API_KEY"];
  const model = env["LLM_MODEL"];
  const online = Boolean(base && key && model);
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const requested = env["LLM_PRICE_AS"] ?? DEFAULT_PRICED_AS;
  const pricedAs = requested in PRICES ? requested : DEFAULT_PRICED_AS;
  const total: LlmSpend = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    pricedAs,
  };
  const account = (req: LlmRequest, body: any, content: string): LlmUsage => {
    const u = body?.usage;
    const real =
      Number.isFinite(u?.prompt_tokens) &&
      Number.isFinite(u?.completion_tokens);
    const inputTokens = real
      ? u.prompt_tokens
      : estimateTokens(
          (req.system ?? "") + req.messages.map((m) => m.content).join(""),
        );
    const outputTokens = real ? u.completion_tokens : estimateTokens(content);
    const usage = {
      inputTokens,
      outputTokens,
      costUsd: priceUsd(pricedAs, inputTokens, outputTokens),
      pricedAs,
      estimated: !real,
    };
    total.calls += 1;
    total.inputTokens += inputTokens;
    total.outputTokens += outputTokens;
    total.costUsd += usage.costUsd;
    console.log(
      JSON.stringify({ msg: "llm usage", ...usage, totalUsd: total.costUsd }),
    );
    return usage;
  };

  return {
    online,
    ...(online ? { model: model! } : {}),
    spend: () => ({ ...total }),
    async complete<T>(
      req: LlmRequest,
      fallback: () => T | Promise<T>,
    ): Promise<LlmResult<T>> {
      const fall = async (error: string): Promise<LlmResult<T>> => ({
        value: await fallback(),
        source: "fallback",
        label: "offline fallback",
        error,
      });
      if (!online) return fall("AI is not configured");
      try {
        const res = await doFetch(
          `${base!.replace(/\/+$/, "")}/chat/completions`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                ...(req.system
                  ? [{ role: "system", content: req.system }]
                  : []),
                ...req.messages,
              ],
              ...(req.json ? { response_format: { type: "json_object" } } : {}),
              ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
              ...(req.temperature !== undefined
                ? { temperature: req.temperature }
                : {}),
            }),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (!res.ok) return fall(`HTTP ${res.status}`);
        const body = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== "string")
          return fall("response had no message content");
        // a paid call is paid even when its answer is then rejected
        const usage = account(req, body, content);
        if (req.json) {
          try {
            return {
              value: JSON.parse(jsonText(content)) as T,
              source: "llm",
              label: `AI (${model})`,
              model: model!,
              usage,
            };
          } catch {
            return { ...(await fall("response was not valid JSON")), usage };
          }
        }
        return {
          value: content,
          source: "llm",
          label: `AI (${model})`,
          model: model!,
          usage,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.name : "error";
        return fall(
          msg === "TimeoutError" || msg === "AbortError"
            ? "timeout"
            : `request failed (${msg})`,
        );
      }
    },
  };
}
