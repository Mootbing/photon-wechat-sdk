import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  WeChatAuthStatus,
  WeChatChat,
  WeChatMediaResult,
  WeChatMessage,
  WeChatSendResult,
} from "./types.js";

/** Error thrown when the agent-wechat API returns a non-2xx response. */
export class AgentWeChatHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`agent-wechat ${path} failed: HTTP ${status}${body ? ` — ${body}` : ""}`);
    this.name = "AgentWeChatHttpError";
  }
}

/**
 * Resolve the agent-wechat bearer token: explicit value, then
 * `AGENT_WECHAT_TOKEN`, then `~/.config/agent-wechat/token`.
 */
export function resolveToken(explicit?: string): string | undefined {
  if (explicit && explicit.length > 0) return explicit;
  const fromEnv = process.env.AGENT_WECHAT_TOKEN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  try {
    const path = join(homedir(), ".config", "agent-wechat", "token");
    const raw = readFileSync(path, "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

export interface AgentWeChatClientOptions {
  baseUrl: string;
  token?: string;
  /** Injectable fetch (for tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Thin, typed HTTP client for the agent-wechat REST server. One instance maps
 * to one logged-in WeChat session (one container).
 */
export class AgentWeChatClient {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AgentWeChatClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = resolveToken(options.token);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** The bearer token in use (for building the VNC login URL). */
  get authToken(): string | undefined {
    return this.token;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AgentWeChatHttpError(res.status, path, text.slice(0, 500));
    }
    return (await res.json()) as T;
  }

  health(): Promise<{ status: string }> {
    return this.request("GET", "/health");
  }

  authStatus(): Promise<WeChatAuthStatus> {
    return this.request("GET", "/api/status/auth");
  }

  listChats(limit?: number, offset?: number): Promise<WeChatChat[]> {
    return this.request("GET", `/api/chats${query({ limit, offset })}`);
  }

  getChat(id: string): Promise<WeChatChat | null> {
    return this.request("GET", `/api/chats/${encodeURIComponent(id)}`);
  }

  findChats(name: string): Promise<WeChatChat[]> {
    return this.request("GET", `/api/chats/find${query({ name })}`);
  }

  listMessages(
    chatId: string,
    limit?: number,
    offset?: number,
  ): Promise<WeChatMessage[]> {
    return this.request(
      "GET",
      `/api/messages/${encodeURIComponent(chatId)}${query({ limit, offset })}`,
    );
  }

  getMedia(chatId: string, localId: number): Promise<WeChatMediaResult> {
    return this.request(
      "GET",
      `/api/messages/${encodeURIComponent(chatId)}/media/${localId}`,
    );
  }

  sendText(chatId: string, text: string): Promise<WeChatSendResult> {
    return this.request("POST", "/api/messages/send", { chatId, text });
  }

  sendImage(
    chatId: string,
    data: string,
    mimeType: string,
  ): Promise<WeChatSendResult> {
    return this.request("POST", "/api/messages/send", {
      chatId,
      image: { data, mimeType },
    });
  }

  sendFile(
    chatId: string,
    data: string,
    filename: string,
  ): Promise<WeChatSendResult> {
    return this.request("POST", "/api/messages/send", {
      chatId,
      file: { data, filename },
    });
  }
}

function query(params: Record<string, unknown>): string {
  const entries = Object.entries(params).filter(([, v]) => v != null);
  if (entries.length === 0) return "";
  return (
    "?" +
    entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&")
  );
}
