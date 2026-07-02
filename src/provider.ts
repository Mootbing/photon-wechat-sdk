import { randomUUID } from "node:crypto";
import { definePlatform, stream } from "@spectrum-ts/core";
import { z } from "zod";
import { AgentWeChatClient } from "./client.js";
import { deliverContent } from "./content.js";
import { ensureLoggedIn, type LoginLogger } from "./login.js";
import {
  baseline,
  newPollState,
  pollOnce,
  type PollLogger,
  type PollState,
  type WeChatInbound,
} from "./poll.js";
import { wechatConfigSchema, type WeChatConfig } from "./types.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Minimal stderr logger so provider logs never pollute a message stream. */
const log: LoginLogger & PollLogger = {
  info: (m) => console.error(`[wechat] ${m}`),
  warn: (m) => console.error(`[wechat] WARN ${m}`),
  debug: (m) => {
    if (process.env.WECHAT_DEBUG) console.error(`[wechat] DEBUG ${m}`);
  },
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Per-session runtime state: the REST client, the logged-in identity, the
 * de-dupe/activity bookkeeping, and an outbound pacing chain.
 */
class WeChatRuntime {
  readonly api: AgentWeChatClient;
  readonly config: WeChatConfig;
  readonly state: PollState = newPollState();
  selfId: string | undefined;
  stopped = false;
  private lastSend = 0;
  private sendChain: Promise<void> = Promise.resolve();

  constructor(config: WeChatConfig) {
    this.config = config;
    this.api = new AgentWeChatClient({ baseUrl: config.baseUrl, token: config.token });
  }

  /** Serialize sends and enforce a minimum gap between them. */
  pace(): Promise<void> {
    const run = this.sendChain.then(async () => {
      const wait = Math.max(0, this.lastSend + this.config.sendPacingMs - Date.now());
      if (wait > 0) await delay(wait);
      this.lastSend = Date.now();
    });
    this.sendChain = run.catch(() => {});
    return run;
  }
}

/**
 * The WeChat provider for Spectrum.
 *
 * Wraps an [`agent-wechat`](https://github.com/thisnick/agent-wechat) server —
 * a headless WeChat client with a REST API — and exposes it as a first-class
 * Spectrum platform. Each inbound message carries the individual sender's wxid,
 * so the Spectrum runtime keeps a separate conversation (and your agent keeps a
 * separate history) per person, even inside group chats.
 *
 * @example
 * ```ts
 * import { Spectrum } from "@spectrum-ts/core";
 * import { wechat } from "photon-wechat-sdk";
 *
 * const app = await Spectrum({ providers: [wechat.config({ token: "…" })] });
 * for await (const [space, message] of app.messages) {
 *   await space.send(`echo: ${message.text}`);
 * }
 * ```
 */
export const wechat = definePlatform("WeChat", {
  config: wechatConfigSchema,
  message: {
    schema: z.object({
      senderName: z.string().optional(),
      isSelf: z.boolean().optional(),
      mentioned: z.boolean().optional(),
      chatType: z.enum(["dm", "group"]).optional(),
      wechatType: z.number().optional(),
      quotedReply: z
        .object({ sender: z.string().optional(), content: z.string() })
        .optional(),
    }),
  },
  lifecycle: {
    createClient: async ({ config }) => {
      const rt = new WeChatRuntime(config);
      await rt.api.health();
      rt.selfId = await ensureLoggedIn(rt.api, config, log);
      await baseline(rt.api, config, rt.state, log);
      log.info(
        `ready — polling every ${config.pollIntervalMs}ms as ${rt.selfId ?? "(unknown)"}` +
          `, groups=${config.groups}`,
      );
      return rt;
    },
    destroyClient: async ({ client }) => {
      client.stopped = true;
    },
  },
  user: {
    resolve: async ({ input }) => ({ id: input.userID }),
  },
  space: {
    get: async ({ input }) => ({ id: input.id }),
    create: async ({ input }) => {
      const target = input.users[0];
      if (!target) {
        throw new Error("WeChat: cannot create a space without a target user.");
      }
      return { id: target.id };
    },
  },
  messages({ client }) {
    return stream<WeChatInbound>((emit, end) => {
      const loop = (async () => {
        while (!client.stopped) {
          try {
            await pollOnce(client.api, client.config, client.state, emit, log);
          } catch (err) {
            log.warn(`poll failed: ${errMessage(err)}`);
          }
          if (client.stopped) break;
          await delay(client.config.pollIntervalMs);
        }
        end();
      })();
      return async () => {
        client.stopped = true;
        await loop.catch(() => {});
      };
    });
  },
  send: async ({ client, content, space }) => {
    if (content.type === "typing" || content.type === "read") {
      // Fire-and-forget control content WeChat does not expose.
      return;
    }
    await client.pace();
    await deliverContent(client.api, space.id, content, client.config);
    return {
      id: `wechat-out:${randomUUID()}`,
      content,
      space: { id: space.id },
      timestamp: new Date(),
    };
  },
});
