import { UnsupportedError, toVCard } from "@spectrum-ts/core";
import type { Content } from "@spectrum-ts/core";
import {
  asAttachment,
  asCustom,
  asText,
  asVoice,
} from "@spectrum-ts/core/authoring";
import type { AgentWeChatClient } from "./client.js";
import type { WeChatConfig, WeChatMessage, WeChatSendResult } from "./types.js";
import { WeChatMsgType } from "./types.js";

const PLATFORM = "WeChat";

/** Map a WeChat media `format` string onto a MIME type. */
function mimeFromFormat(format: string): string {
  switch (format.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "mp3":
      return "audio/mpeg";
    case "m4a":
      return "audio/mp4";
    case "silk":
      return "audio/silk";
    case "wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
}

function bytesReaders(bytes: Buffer): {
  read: () => Promise<Buffer>;
  stream: () => Promise<ReadableStream>;
} {
  return {
    read: async () => bytes,
    stream: async () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      }),
  };
}

/**
 * Fetch a materialized media attachment for a WeChat message. Returns `null`
 * when media is still `pending` (not yet downloaded by WeChat) or unsupported.
 */
async function fetchMedia(
  client: AgentWeChatClient,
  msg: WeChatMessage,
): Promise<Content | null> {
  const media = await client.getMedia(msg.chatId, msg.localId).catch(() => null);
  if (!media || !media.data) return null;
  if (media.type === "pending" || media.type === "unsupported") return null;

  const bytes = Buffer.from(media.data, "base64");
  const mimeType = mimeFromFormat(media.format);
  const { read, stream } = bytesReaders(bytes);
  const name = media.filename || defaultName(msg.type, media.format);

  if (msg.type === WeChatMsgType.VOICE) {
    return asVoice({ name, mimeType, size: bytes.length, read, stream });
  }
  return asAttachment({ name, mimeType, size: bytes.length, read, stream });
}

function defaultName(type: number, format: string): string {
  const ext = format && format.length <= 5 ? format : "bin";
  if (type === WeChatMsgType.IMAGE) return `image.${ext || "jpg"}`;
  if (type === WeChatMsgType.VIDEO || type === WeChatMsgType.MICROVIDEO)
    return `video.${ext || "mp4"}`;
  if (type === WeChatMsgType.VOICE) return `voice.${ext || "m4a"}`;
  return `file.${ext}`;
}

/**
 * Convert an inbound WeChat message into Spectrum `Content`. Returns `null`
 * for messages that should not reach the agent (system notices, recalls, or
 * empty payloads).
 */
export async function inboundContent(
  client: AgentWeChatClient,
  msg: WeChatMessage,
  config: WeChatConfig,
): Promise<Content | null> {
  const text = msg.content?.trim() ?? "";

  switch (msg.type) {
    case WeChatMsgType.TEXT:
      return text ? asText(text) : null;

    case WeChatMsgType.IMAGE:
    case WeChatMsgType.VIDEO:
    case WeChatMsgType.MICROVIDEO:
    case WeChatMsgType.VOICE: {
      if (config.downloadMedia) {
        const media = await fetchMedia(client, msg);
        if (media) return media;
      }
      return asCustom({ platform: PLATFORM, wechatType: msg.type, pending: true });
    }

    case WeChatMsgType.APP: {
      if (config.downloadMedia) {
        const media = await fetchMedia(client, msg);
        if (media) return media;
      }
      return text
        ? asText(text)
        : asCustom({ platform: PLATFORM, wechatType: msg.type });
    }

    case WeChatMsgType.EMOJI:
      return text ? asText(text) : asText("[emoji]");

    case WeChatMsgType.CONTACT_CARD:
      return asCustom({ platform: PLATFORM, kind: "contact-card", raw: msg.content });

    case WeChatMsgType.LOCATION:
      return asCustom({ platform: PLATFORM, kind: "location", raw: msg.content });

    case WeChatMsgType.SYSTEM:
    case WeChatMsgType.RECALLED:
      return null;

    default:
      return text
        ? asText(text)
        : asCustom({ platform: PLATFORM, wechatType: msg.type, raw: msg.content });
  }
}

function ensureSent(res: WeChatSendResult): void {
  if (!res.success) {
    throw new Error(`WeChat send failed: ${res.error ?? "unknown error"}`);
  }
}

/**
 * Deliver a Spectrum `Content` value to a WeChat chat. Unsupported content
 * types throw `UnsupportedError`; fire-and-forget control content (typing,
 * read receipts) is silently accepted as a no-op.
 */
export async function deliverContent(
  client: AgentWeChatClient,
  chatId: string,
  content: Content,
  _config: WeChatConfig,
): Promise<void> {
  switch (content.type) {
    case "text":
      ensureSent(await client.sendText(chatId, content.text));
      return;

    case "markdown":
      ensureSent(await client.sendText(chatId, content.markdown));
      return;

    case "richlink":
      ensureSent(await client.sendText(chatId, content.url));
      return;

    case "app":
      ensureSent(await client.sendText(chatId, await content.url()));
      return;

    case "attachment": {
      const buf = await content.read();
      const b64 = buf.toString("base64");
      if (content.mimeType?.startsWith("image/")) {
        ensureSent(await client.sendImage(chatId, b64, content.mimeType));
      } else {
        ensureSent(await client.sendFile(chatId, b64, content.name ?? "file"));
      }
      return;
    }

    case "voice": {
      // agent-wechat has no native voice send; deliver as an audio file.
      const buf = await content.read();
      ensureSent(
        await client.sendFile(chatId, buf.toString("base64"), content.name ?? "voice.m4a"),
      );
      return;
    }

    case "contact": {
      const vcard = await toVCard(content);
      const b64 = Buffer.from(vcard, "utf8").toString("base64");
      const name = content.name?.formatted ?? content.name?.first ?? "contact";
      ensureSent(await client.sendFile(chatId, b64, `${name}.vcf`));
      return;
    }

    case "reply":
      // WeChat's send API cannot quote; deliver the reply body as a message.
      await deliverContent(client, chatId, content.content, _config);
      return;

    case "reaction":
      throw UnsupportedError.content("reaction", PLATFORM);

    case "typing":
    case "read":
      // Fire-and-forget control signals WeChat does not expose — no-op.
      return;

    default:
      throw UnsupportedError.content((content as { type: string }).type, PLATFORM);
  }
}
