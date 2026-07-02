import { z } from "zod";

/**
 * Configuration for the WeChat provider.
 *
 * Every field has a sensible default, so `wechat.config()` works out of the box
 * against a local `agent-wechat` container. Values map 1:1 onto the
 * `agent-wechat` REST server (https://github.com/thisnick/agent-wechat).
 */
export const wechatConfigSchema = z.object({
  /** Base URL of the agent-wechat REST server. */
  baseUrl: z.string().url().default("http://localhost:6174"),
  /**
   * Bearer token for the agent-wechat API. When omitted, the provider falls
   * back to `AGENT_WECHAT_TOKEN`, then to `~/.config/agent-wechat/token`.
   */
  token: z.string().optional(),
  /** How often to poll for new messages, in milliseconds. */
  pollIntervalMs: z.number().int().positive().default(2000),
  /** Max number of recent chats to scan per poll. */
  chatLimit: z.number().int().positive().max(500).default(50),
  /** Max number of recent messages to read per active chat, per poll. */
  messageLimit: z.number().int().positive().max(200).default(30),
  /**
   * Group-chat policy. WeChat groups fan a single space out to many senders;
   * this decides whether (and which) group messages reach your agent.
   *
   * - `exclude` (default) — ignore all group (`@chatroom`) messages.
   * - `include` — surface every group message, one per sender.
   * - `mentionsOnly` — surface a group message only when the bot is @-mentioned.
   */
  groups: z.enum(["exclude", "include", "mentionsOnly"]).default("exclude"),
  /** Download inbound media (image/voice/video/file) bytes lazily. */
  downloadMedia: z.boolean().default(true),
  /** Minimum spacing between outbound sends, in milliseconds (anti-flood). */
  sendPacingMs: z.number().int().nonnegative().default(800),
  /** Block startup until the WeChat account is logged in (drives the QR flow). */
  waitForLogin: z.boolean().default(true),
  /** How long to wait for QR login before giving up, in milliseconds. */
  loginTimeoutMs: z.number().int().positive().default(300_000),
  /** Print the VNC login URL / QR hint to the console when login is required. */
  logQr: z.boolean().default(true),
});

export type WeChatConfig = z.infer<typeof wechatConfigSchema>;
export type WeChatConfigInput = z.input<typeof wechatConfigSchema>;

// --- agent-wechat REST payloads (camelCase, per the server's serde config) ---

export interface WeChatChat {
  id: string;
  username: string;
  name: string;
  remark?: string;
  lastMessagePreview?: string;
  lastMessageSender?: string;
  lastActivityAt?: string;
  unreadCount: number;
  isGroup: boolean;
  lastMsgLocalId?: number;
}

export interface WeChatReplyInfo {
  sender?: string;
  content: string;
}

export interface WeChatMessage {
  /** Per-chat local row id; stable while the message DB persists. */
  localId: number;
  /** WeChat server-assigned id; `0` when not yet acked (outgoing/system). */
  serverId: number;
  chatId: string;
  /** Sender wxid. For a DM this equals `chatId`; for a group it is the member. */
  sender?: string;
  /** Display name (remark → nickname → wxid). May be absent for group members. */
  senderName?: string;
  /** WeChat message type: 1 text, 3 image, 34 voice, 43 video, 47 emoji, 49 app… */
  type: number;
  content: string;
  /** RFC3339 timestamp. */
  timestamp: string;
  isMentioned?: boolean;
  isSelf?: boolean;
  reply?: WeChatReplyInfo;
}

export interface WeChatSendResult {
  success: boolean;
  error?: string;
  messageId?: string;
}

export type WeChatMediaKind =
  | "image"
  | "emoji"
  | "voice"
  | "file"
  | "video"
  | "pending"
  | "unsupported";

export interface WeChatMediaResult {
  type: WeChatMediaKind | string;
  /** Base64-encoded bytes when materialized. */
  data?: string;
  url?: string;
  format: string;
  filename: string;
}

export type WeChatAuthState =
  | "logged_in"
  | "logged_out"
  | "app_not_running"
  | "unknown";

export interface WeChatAuthStatus {
  status: WeChatAuthState;
  loggedInUser?: string;
}

/** WeChat message-type constants the provider maps explicitly. */
export const WeChatMsgType = {
  TEXT: 1,
  IMAGE: 3,
  VOICE: 34,
  CONTACT_CARD: 42,
  VIDEO: 43,
  EMOJI: 47,
  LOCATION: 48,
  APP: 49,
  MICROVIDEO: 62,
  SYSTEM: 10000,
  RECALLED: 10002,
} as const;
