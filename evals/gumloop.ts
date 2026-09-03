/**
 * A thin client over the two Gumloop endpoints an experiment needs.
 *
 *   POST /api/v1/start_agent            → { interaction_id, status }
 *   GET  /api/v1/agent_status/{id}      → { state, messages, response }
 *
 * The interesting part is `trajectoryFrom`. Gumloop returns the conversation
 * transcript, not an instrumented result object, so the tool calls have to be
 * reconstructed from `tool_invocation` parts. That is the same constraint you
 * hit scoring production traffic — you get the transcript and nothing else —
 * so the scorers built on it work unchanged against live logs.
 */

/** Native since Node 20.12, no dependency. Here because every script that
 *  talks to Gumloop imports this module. */
try {
  process.loadEnvFile();
} catch {
  // No .env, or unreadable. Real environment variables still apply, which is
  // how CI and one-off overrides work.
}

const BASE = process.env.GUMLOOP_API_BASE ?? "https://api.gumloop.com/api/v1";

export interface GumloopConfig {
  apiKey: string;
  userId: string;
  gummieId: string;
}

export function configFromEnv(gummieId?: string): GumloopConfig {
  const apiKey = process.env.GUMLOOP_API_KEY;
  const userId = process.env.GUMLOOP_USER_ID;
  const agent = gummieId ?? process.env.GUMLOOP_GUMMIE_ID;

  const missing = [
    !apiKey && "GUMLOOP_API_KEY",
    !userId && "GUMLOOP_USER_ID",
    !agent && "GUMLOOP_GUMMIE_ID",
  ].filter(Boolean);

  if (missing.length) {
    throw new Error(
      `Missing ${missing.join(", ")}. The key and user id are at ` +
        "gumloop.com/settings/profile/general; the gummie id is the last path " +
        "segment of the agent's URL. See .env.example.",
    );
  }
  return { apiKey: apiKey!, userId: userId!, gummieId: agent! };
}

export interface ToolCallRecord {
  name: string;
  /** The SQL this call executed, when it was a query. */
  sql: string | null;
  /** Neither is scored. Carried so a saved run explains itself: when a number
   *  is wrong, the first question is what the query returned. */
  resultText: string;
  state: string;
}

export interface AgentRun {
  answer: string;
  trajectory: ToolCallRecord[];
  interactionId: string;
  state: string;
  durationMs: number;
  error?: string;
}

/** Gumloop namespaces connector tools and the separator varies, so reduce to
 *  the bare name rather than depend on a string this repo did not choose. */
export function normalizeToolName(raw: string): string {
  const tail = raw.split(/[.\/]|__/).pop() ?? raw;
  return tail.trim().toLowerCase();
}

/** Substring, not equality: a scorer that missed this because the tool name
 *  gained a prefix would report "the agent ran no queries" — alarming, and
 *  wrong. */
export function isQueryTool(name: string): boolean {
  const n = normalizeToolName(name);
  return n.includes("query") || n.includes("sql");
}

/** Pull the SQL text out of a tool call's arguments, whatever the key is called. */
export function sqlFrom(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  for (const key of ["query", "sql", "statement", "sql_query", "queryString"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  // Fall back to any string value that looks like SQL.
  for (const value of Object.values(args)) {
    if (typeof value === "string" && /\bSELECT\b/i.test(value)) return value;
  }
  return null;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface TranscriptPart {
  type?: string;
  text?: string;
  toolName?: string;
  toolCallState?: string;
  result?: { args?: Record<string, unknown>; result?: unknown };
}

interface TranscriptMessage {
  role?: string;
  content?: string;
  parts?: TranscriptPart[];
}

export function trajectoryFrom(messages: TranscriptMessage[] | undefined): ToolCallRecord[] {
  const calls: ToolCallRecord[] = [];
  for (const message of messages ?? []) {
    for (const part of message.parts ?? []) {
      if (part.type !== "tool_invocation" || !part.toolName) continue;
      calls.push({
        name: normalizeToolName(part.toolName),
        sql: sqlFrom(part.result?.args),
        resultText: asText(part.result?.result),
        state: part.toolCallState ?? "unknown",
      });
    }
  }
  return calls;
}

/** Prefer the transcript's text over the top-level `response`: grading
 *  something the reviewer cannot see in the trace is worse than useless. */
export function answerFrom(payload: { messages?: TranscriptMessage[]; response?: string }): string {
  const assistant = (payload.messages ?? []).filter((m) => m.role === "assistant");
  const last = assistant[assistant.length - 1];
  const text = (last?.parts ?? [])
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!.trim())
    .join("\n")
    .trim();
  return text || payload.response?.trim() || last?.content?.trim() || "";
}

async function request(path: string, init: RequestInit, apiKey: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return body ? JSON.parse(body) : {};
}

export interface RunOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/** Start one agent interaction and poll it to completion. */
export async function runAgent(
  config: GumloopConfig,
  message: string,
  options: RunOptions = {},
): Promise<AgentRun> {
  // Gumloop's own guidance: poll every 2-5s, never faster than 1s.
  const pollIntervalMs = options.pollIntervalMs ?? 3000;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const startedAt = Date.now();

  const started = await request(
    "/start_agent",
    {
      method: "POST",
      body: JSON.stringify({
        gummie_id: config.gummieId,
        message,
        user_id: config.userId,
      }),
    },
    config.apiKey,
  );

  const interactionId: string = started.interaction_id;
  if (!interactionId) {
    throw new Error(`start_agent returned no interaction_id: ${JSON.stringify(started)}`);
  }

  for (;;) {
    if (Date.now() - startedAt > timeoutMs) {
      return {
        answer: "",
        trajectory: [],
        interactionId,
        state: "TIMEOUT",
        durationMs: Date.now() - startedAt,
        error: `still running after ${Math.round(timeoutMs / 1000)}s`,
      };
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
    // user_id goes on the query string as well as in the start_agent body.
    // The bearer token authenticates the request; this identifies whose
    // interaction is being polled, and the endpoint rejects the call without
    // it — 400 "user_id is required", after start_agent has already succeeded
    // and the agent is running.
    const status = await request(
      `/agent_status/${interactionId}?user_id=${encodeURIComponent(config.userId)}`,
      { method: "GET" },
      config.apiKey,
    );

    if (status.state === "COMPLETED") {
      return {
        answer: answerFrom(status),
        trajectory: trajectoryFrom(status.messages),
        interactionId,
        state: status.state,
        durationMs: Date.now() - startedAt,
      };
    }
    if (status.state === "FAILED") {
      return {
        answer: "",
        trajectory: trajectoryFrom(status.messages),
        interactionId,
        state: status.state,
        durationMs: Date.now() - startedAt,
        error: status.error_message ?? "agent reported FAILED",
      };
    }
  }
}
