/**
 * Minimal Anthropic Messages API adapter (fetch, no SDK). Ported from ContraOS's provider hygiene:
 * key normalization before any request, timeouts that also cover reading the body, one retry on
 * 429/503/529, response size cap, and error bodies never read or logged (they can echo inputs).
 * The API key travels only in a header.
 */

export interface ModelSettings {
  apiKey: string;
  model: string;
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

export function settingsFromEnv(env: Record<string, string | undefined>): { ok: true; settings: ModelSettings } | { ok: false; message: string } {
  const k = normalizeApiKey(env.ANTHROPIC_API_KEY);
  if (!k.ok) return { ok: false, message: k.reason === "EMPTY" ? "Set ANTHROPIC_API_KEY" : "ANTHROPIC_API_KEY contains characters that can't go in an HTTP header; re-enter it without line breaks" };
  return { ok: true, settings: { apiKey: k.key, model: (env.ANTHROPIC_MODEL ?? "").trim() || "claude-opus-5-5" } };
}

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

export async function callTool(
  settings: ModelSettings,
  req: { system: string; user: string; tool: { name: string; description: string; input_schema: unknown }; maxTokens?: number },
  opts: CallOptions = {},
): Promise<CallResult> {
  const key = normalizeApiKey(settings.apiKey);
  if (!key.ok) return { status: "INVALID_CREDENTIAL", message: "API key is empty or contains characters that can't be sent in a header" };
  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxRetries = opts.maxRetries ?? 1;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxChars = opts.maxResponseChars ?? 200_000;
  const body = JSON.stringify({
    model: settings.model,
    max_tokens: req.maxTokens ?? 4096,
    temperature: 0,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
    tools: [req.tool],
    tool_choice: { type: "tool", name: req.tool.name },
  });

  let res: Response | undefined;
  let raw = "";
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
      if (!res.ok) void res.body?.cancel().catch(() => {});
      else raw = await res.text();
      if (retryable && attempt < maxRetries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
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
  if (res.status === 401 || res.status === 403) return { status: "INVALID_CREDENTIAL", message: `API returned HTTP ${res.status}` };
  if (res.status === 429) return { status: "RATE_LIMITED", message: "Rate limited" };
  if (!res.ok) return { status: "MODEL_ERROR", message: `API returned HTTP ${res.status}` };
  if (raw.length > maxChars) return { status: "INVALID_OUTPUT", message: "Response too large" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "INVALID_OUTPUT", message: "Malformed API response" };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.content)) return { status: "INVALID_OUTPUT", message: "Unexpected response shape" };
  const uses = parsed.content.filter((p) => isRecord(p) && p.type === "tool_use" && p.name === req.tool.name) as Record<string, unknown>[];
  if (uses.length !== 1) return { status: "INVALID_OUTPUT", message: `Expected exactly one ${req.tool.name} call, got ${uses.length}` };
  return { status: "OK", toolInput: uses[0]!.input, model: typeof parsed.model === "string" ? parsed.model : settings.model };
}
