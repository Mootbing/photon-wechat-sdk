import type { Content } from "@spectrum-ts/core";
import type { AgentWeChatClient } from "./client.js";
import { inboundContent } from "./content.js";
import type { WeChatChat, WeChatConfig, WeChatMessage } from "./types.js";

/** The provider's inbound-message shape (base fields + WeChat extensions). */
export interface WeChatInbound {
  id: string;
  content: Content;
  sender: { id: string };
  space: { id: string };
  timestamp: Date;
  senderName?: string;
  isSelf: boolean;
  mentioned: boolean;
  chatType: "dm" | "group";
  wechatType: number;
  quotedReply?: { sender?: string; content: string };
}

export type Emit = (msg: WeChatInbound) => Promise<void> | void;

/** De-dupe and activity bookkeeping carried across polls. */
export interface PollState {
  seen: Set<string>;
  activity: Map<string, string>;
}

export function newPollState(): PollState {
  return { seen: new Set(), activity: new Map() };
}

export interface PollLogger {
  warn: (msg: string) => void;
  debug: (msg: string) => void;
}

const noopLog: PollLogger = { warn: () => {}, debug: () => {} };

export const isGroupChat = (chatId: string): boolean =>
  chatId.endsWith("@chatroom");

/**
 * Stable de-dupe key for a WeChat message. Prefers the per-chat `localId`,
 * then the server id, then a content-shaped fallback.
 */
export function messageKey(m: WeChatMessage): string {
  if (m.localId && m.localId > 0) return `${m.chatId}:l:${m.localId}`;
  if (m.serverId && m.serverId > 0) return `${m.chatId}:s:${m.serverId}`;
  return `${m.chatId}:f:${m.timestamp}:${m.sender ?? ""}:${m.content.length}`;
}

/** A change marker so unchanged chats can be skipped between polls. */
export function activityMarker(chat: WeChatChat): string {
  return `${chat.lastMsgLocalId ?? ""}|${chat.lastActivityAt ?? ""}|${chat.unreadCount}`;
}

/**
 * Resolve the per-person sender id. In a DM the sender is the peer (which
 * equals the chat id). In a group the sender is the individual member's wxid —
 * and if that is missing we return `null` and drop the message rather than
 * collapsing distinct people onto the room id.
 */
export function resolveSenderId(m: WeChatMessage, group: boolean): string | null {
  if (group) return m.sender && m.sender.length > 0 ? m.sender : null;
  return m.sender && m.sender.length > 0 ? m.sender : m.chatId;
}

export function groupAllowed(m: WeChatMessage, config: WeChatConfig): boolean {
  if (config.groups === "include") return true;
  if (config.groups === "mentionsOnly") return m.isMentioned === true;
  return false;
}

export function parseTimestamp(s: string): Date {
  const t = Date.parse(s);
  return Number.isNaN(t) ? new Date() : new Date(t);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Record the current tail of every chat as "seen" so live polling starts from
 * now instead of replaying history on startup.
 */
export async function baseline(
  api: AgentWeChatClient,
  config: WeChatConfig,
  state: PollState,
  log: PollLogger = noopLog,
): Promise<void> {
  const chats = await api.listChats(config.chatLimit);
  for (const chat of chats) {
    state.activity.set(chat.id, activityMarker(chat));
    try {
      const msgs = await api.listMessages(chat.id, config.messageLimit);
      for (const m of msgs) state.seen.add(messageKey(m));
    } catch (err) {
      log.debug(`baseline read failed for ${chat.id}: ${errMessage(err)}`);
    }
  }
}

/**
 * One polling pass: scan recently-active chats and emit each new inbound
 * message as a distinct, per-sender Spectrum message.
 */
export async function pollOnce(
  api: AgentWeChatClient,
  config: WeChatConfig,
  state: PollState,
  emit: Emit,
  log: PollLogger = noopLog,
): Promise<void> {
  const chats = await api.listChats(config.chatLimit);
  for (const chat of chats) {
    const marker = activityMarker(chat);
    if (state.activity.get(chat.id) === marker) continue;
    state.activity.set(chat.id, marker);

    let msgs: WeChatMessage[];
    try {
      msgs = await api.listMessages(chat.id, config.messageLimit);
    } catch (err) {
      log.warn(`listMessages(${chat.id}) failed: ${errMessage(err)}`);
      continue;
    }

    // The API returns newest-first; emit oldest-first for natural ordering.
    for (const m of msgs.slice().reverse()) {
      const key = messageKey(m);
      if (state.seen.has(key)) continue;
      state.seen.add(key);
      if (m.isSelf) continue;

      const group = isGroupChat(m.chatId);
      if (group && !groupAllowed(m, config)) continue;

      const senderId = resolveSenderId(m, group);
      if (!senderId) {
        log.debug(`group message without resolvable sender in ${m.chatId} — skipped`);
        continue;
      }

      let content: Content | null;
      try {
        content = await inboundContent(api, m, config);
      } catch (err) {
        log.warn(`content mapping failed for ${key}: ${errMessage(err)}`);
        continue;
      }
      if (!content) continue;

      await emit({
        id: key,
        content,
        sender: { id: senderId },
        space: { id: m.chatId },
        timestamp: parseTimestamp(m.timestamp),
        senderName: m.senderName,
        isSelf: m.isSelf ?? false,
        mentioned: m.isMentioned ?? false,
        chatType: group ? "group" : "dm",
        wechatType: m.type,
        ...(m.reply
          ? { quotedReply: { sender: m.reply.sender, content: m.reply.content } }
          : {}),
      });
    }
  }
}
