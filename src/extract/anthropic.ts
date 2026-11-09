/**
 * Minimal Anthropic Messages API adapter (fetch, no SDK). Ported from ContraOS's provider hygiene:
 * key normalization before any request, timeouts that also cover reading the body, one retry on
 * 429/503/529, and response size caps. Error bodies are read only up to 2,000 characters and only
 * their error.type and error.message are reported (cut to 300), never the request, email or key.
 * The API key travels only in a header.
 *
 * Written for models with thinking always on (claude-opus-5-5, claude-fable-5-1): no temperature,
 * tool_choice "auto" (forced tool use is a 400 there), effort sent explicitly.
 */

export type Effort = "low" | "medium" | "high";
export const EFFORTS: readonly Effort[] = ["low", "medium", "high"];

export interface ModelSettings {
  apiKey: string;
  model: string;
  /** Thinking depth. Defaults to "medium" when omitted. */
  effort?: Effort;
}

export type CallResult =
  | { status: "OK"; toolInput: unknown; model: string }
  | { status: "INVALID_CREDENTIAL" | "NETWORK_ERROR" | "TIMEOUT" | "RATE_LIMITED" | "MODEL_ERROR" | "INVALID_OUTPUT"; message: string };

export interface CallOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  maxResponseChars?: number;
}

export function normalizeApiKey(raw: string | undefined): { ok: true; key: string } | { ok: false; reason: "EMPTY" | "INVALID_CHARACTERS" } {
  const key = (raw ?? "").replace(/^\s+|\s+$/g, "");
  if (key.length === 0) return { ok: false, reason: "EMPTY" };
  if (/[^\x21-\x7e]/.test(key)) return { ok: false, reason: "INVALID_CHARACTERS" };
  return { ok: true, key };
}

/**
 * Contra uses its OWN variable names, loaded from .env.local. ANTHROPIC_API_KEY and ANTHROPIC_MODEL are
 * deliberately NOT read: Claude Code reads those too, so exporting them in a terminal would silently
 * change the coding session's model or bill it to the API key.
 */
export function settingsFromEnv(env: Record<string, string | undefined>): { ok: true; settings: ModelSettings } | { ok: false; message: string } {
  const k = normalizeApiKey(env.CONTRA_ANTHROPIC_API_KEY);
  if (!k.ok) {
    return {
      ok: false,
      message:
        k.reason === "EMPTY"
          ? "Put CONTRA_ANTHROPIC_API_KEY in .env.local (copy .env.example). Do not export ANTHROPIC_API_KEY in a Claude Code terminal."
          : "CONTRA_ANTHROPIC_API_KEY contains characters that can't go in an HTTP header; re-enter it without line breaks",
    };
  }
  const effortRaw = (env.CONTRA_EFFORT ?? "").trim() || "medium";
  if (!(EFFORTS as readonly string[]).includes(effortRaw)) {
    return { ok: false, message: `CONTRA_EFFORT must be one of ${EFFORTS.join(", ")}` };
  }
  return {
    ok: true,
    settings: { apiKey: k.key, model: (env.CONTRA_MODEL ?? "").trim() || "claude-opus-5-5", effort: effortRaw as Effort },
  };
}

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

const ERROR_BODY_CAP = 2_000;
const ERROR_FIELD_CAP = 300;

/** Reads at most ERROR_BODY_CAP characters of an error body, then stops reading. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < ERROR_BODY_CAP) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return out.slice(0, ERROR_BODY_CAP);
}

/** Only error.type and error.message, each cut to ERROR_FIELD_CAP. Anything else in the body is dropped. */
function describeError(status: number, body: string): string {
  let detail = "";
  try {
    const parsed: unknown = JSON.parse(body);
    const err = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
    if (err) {
      const type = typeof err.type === "string" ? err.type.slice(0, ERROR_FIELD_CAP) : "";
      const message = typeof err.message === "string" ? err.message.slice(0, ERROR_FIELD_CAP) : "";
      detail = [type, message].filter(Boolean).join(": ");
    }
  } catch {
    /* not JSON (or cut at the cap): report the status only */
  }
  return detail ? `API returned HTTP ${status} (${detail})` : `API returned HTTP ${status}`;
}

function describeNoToolCall(parsed: Record<string, unknown>, toolName: string, count: number): string {
  const base = `Expected exactly one ${toolName} call, got ${count}`;
  if (parsed.stop_reason === "max_tokens") return `${base}: the response hit the max_tokens limit (stop_reason max_tokens)`;
  if (parsed.stop_reason === "refusal") {
    const sd = parsed.stop_details;
    const category = isRecord(sd) && typeof sd.category === "string" ? sd.category.slice(0, ERROR_FIELD_CAP) : "";
    return `${base}: the model refused (stop_reason refusal${category ? `, category ${category}` : ""})`;
  }
  return typeof parsed.stop_reason === "string" ? `${base} (stop_reason ${parsed.stop_reason.slice(0, 50)})` : base;
}

export async function callTool(
  settings: ModelSettings,
  req: { system: string; user: string; tool: { name: string; description: string; input_schema: unknown }; maxTokens?: number },
  opts: CallOptions = {},
): Promise<CallResult> {
  const key = normalizeApiKey(settings.apiKey);
  if (!key.ok) return { status: "INVALID_CREDENTIAL", message: "API key is empty or contains characters that can't be sent in a header" };
  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const maxRetries = opts.maxRetries ?? 1;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxChars = opts.maxResponseChars ?? 200_000;
  const body = JSON.stringify({
    model: settings.model,
    max_tokens: req.maxTokens ?? 16_000, // thinking counts toward this
    system: req.system,
    messages: [{ role: "user", content: req.user }],
    tools: [req.tool],
    tool_choice: { type: "auto" },
    output_config: { effort: settings.effort ?? "medium" },
  });

  let res: Response | undefined;
  let raw = "";
  let errorBody = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetcher("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key.key, "anthropic-version": "2023-06-01" },
        body,
        signal: controller.signal,
      });
      const retryable = [429, 503, 529].includes(res.status);
      if (retryable && attempt < maxRetries) {
        void res.body?.cancel().catch(() => {});
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (!res.ok) errorBody = await readCapped(res);
      else raw = await res.text();
    } catch (e) {
      const name = isRecord(e) ? String(e.name) : "";
      return name === "AbortError" || name === "TimeoutError"
        ? { status: "TIMEOUT", message: "Model did not answer in time; nothing was changed" }
        : { status: "NETWORK_ERROR", message: "Model API unreachable; nothing was changed" };
    } finally {
      clearTimeout(timer);
    }
    break;
  }
  if (!res) return { status: "NETWORK_ERROR", message: "Model API unreachable; nothing was changed" };
  if (res.status === 401 || res.status === 403) return { status: "INVALID_CREDENTIAL", message: describeError(res.status, errorBody) };
  if (res.status === 429) return { status: "RATE_LIMITED", message: `Rate limited: ${describeError(res.status, errorBody)}` };
  if (!res.ok) return { status: "MODEL_ERROR", message: describeError(res.status, errorBody) };
  if (raw.length > maxChars) return { status: "INVALID_OUTPUT", message: "Response too large" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "INVALID_OUTPUT", message: "Malformed API response" };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.content)) return { status: "INVALID_OUTPUT", message: "Unexpected response shape" };
  const uses = parsed.content.filter((p) => isRecord(p) && p.type === "tool_use" && p.name === req.tool.name) as Record<string, unknown>[];
  if (uses.length !== 1) return { status: "INVALID_OUTPUT", message: describeNoToolCall(parsed, req.tool.name, uses.length) };
  return { status: "OK", toolInput: uses[0]!.input, model: typeof parsed.model === "string" ? parsed.model : settings.model };
}
