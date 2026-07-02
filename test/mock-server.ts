import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  WeChatAuthStatus,
  WeChatChat,
  WeChatMediaResult,
  WeChatMessage,
} from "../src/types.js";

export interface SentRecord {
  chatId: string;
  text?: string;
  image?: { data: string; mimeType: string };
  file?: { data: string; filename: string };
}

export interface MockOptions {
  auth?: WeChatAuthStatus;
  chats?: WeChatChat[];
  messagesByChat?: Record<string, WeChatMessage[]>;
  media?: Record<string, WeChatMediaResult>; // key: `${chatId}:${localId}`
}

/**
 * An in-process fake of the agent-wechat REST server, faithful to its routes,
 * camelCase payloads, and newest-first message ordering.
 */
export class MockAgentWeChat {
  readonly sent: SentRecord[] = [];
  private server?: Server;
  private opts: Required<MockOptions>;

  constructor(opts: MockOptions = {}) {
    this.opts = {
      auth: opts.auth ?? { status: "logged_in", loggedInUser: "wxid_selfbot" },
      chats: opts.chats ?? [],
      messagesByChat: opts.messagesByChat ?? {},
      media: opts.media ?? {},
    };
  }

  setAuth(auth: WeChatAuthStatus): void {
    this.opts.auth = auth;
  }
  setChats(chats: WeChatChat[]): void {
    this.opts.chats = chats;
  }
  setMessages(chatId: string, msgs: WeChatMessage[]): void {
    this.opts.messagesByChat[chatId] = msgs;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve),
    );
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
  }

  private json(res: import("node:http").ServerResponse, body: unknown, code = 200) {
    const text = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json" });
    res.end(text);
  }

  private handle(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/health") return this.json(res, { status: "ok" });
    if (method === "GET" && path === "/api/status/auth")
      return this.json(res, this.opts.auth);

    if (method === "GET" && path === "/api/chats")
      return this.json(res, this.opts.chats);

    if (method === "GET" && path === "/api/chats/find") {
      const name = (url.searchParams.get("name") ?? "").toLowerCase();
      return this.json(
        res,
        this.opts.chats.filter((c) => c.name.toLowerCase().includes(name)),
      );
    }

    const mediaMatch = path.match(/^\/api\/messages\/([^/]+)\/media\/(\d+)$/);
    if (method === "GET" && mediaMatch) {
      const chatId = decodeURIComponent(mediaMatch[1]!);
      const localId = mediaMatch[2]!;
      const media = this.opts.media[`${chatId}:${localId}`];
      return this.json(
        res,
        media ?? { type: "unsupported", format: "", filename: "" },
      );
    }

    const msgMatch = path.match(/^\/api\/messages\/([^/]+)$/);
    if (method === "GET" && msgMatch) {
      const chatId = decodeURIComponent(msgMatch[1]!);
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const all = this.opts.messagesByChat[chatId] ?? [];
      return this.json(res, all.slice(0, limit));
    }

    if (method === "POST" && path === "/api/messages/send") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as SentRecord;
          this.sent.push(parsed);
          this.json(res, { success: true });
        } catch (err) {
          this.json(res, { success: false, error: String(err) }, 400);
        }
      });
      return;
    }

    this.json(res, { error: "not found" }, 404);
  }
}

/** Build a WeChat message with sensible defaults for tests. */
export function msg(partial: Partial<WeChatMessage> & { chatId: string }): WeChatMessage {
  return {
    localId: partial.localId ?? 1,
    serverId: partial.serverId ?? 0,
    chatId: partial.chatId,
    sender: partial.sender,
    senderName: partial.senderName,
    type: partial.type ?? 1,
    content: partial.content ?? "hello",
    timestamp: partial.timestamp ?? "2026-07-02T00:00:00.000Z",
    isMentioned: partial.isMentioned,
    isSelf: partial.isSelf,
    reply: partial.reply,
  };
}

/** Build a chat with sensible defaults for tests. */
export function chat(partial: Partial<WeChatChat> & { id: string }): WeChatChat {
  return {
    id: partial.id,
    username: partial.username ?? partial.id,
    name: partial.name ?? partial.id,
    remark: partial.remark,
    lastMessagePreview: partial.lastMessagePreview,
    lastMessageSender: partial.lastMessageSender,
    lastActivityAt: partial.lastActivityAt,
    unreadCount: partial.unreadCount ?? 0,
    isGroup: partial.isGroup ?? partial.id.endsWith("@chatroom"),
    lastMsgLocalId: partial.lastMsgLocalId,
  };
}
