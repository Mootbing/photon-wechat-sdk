/**
 * Minimal echo bot: connect the WeChat provider to Spectrum and reply to every
 * inbound text message. Run against a live agent-wechat container:
 *
 *   AGENT_WECHAT_TOKEN=$(cat ~/.config/agent-wechat/token) pnpm tsx examples/echo-bot.ts
 */
import { Spectrum } from "@spectrum-ts/core";
import { wechat } from "../src/index.js";

const app = await Spectrum({
  providers: [
    wechat.config({
      baseUrl: process.env.AGENT_WECHAT_URL ?? "http://localhost:6174",
      token: process.env.AGENT_WECHAT_TOKEN,
      pollIntervalMs: 1500,
      groups: "mentionsOnly",
    }),
  ],
});

console.error("[echo-bot] listening for WeChat messages…");

for await (const [space, message] of app.messages) {
  const text = message.content.type === "text" ? message.content.text : undefined;
  if (!text) continue;
  console.error(`[echo-bot] ${message.sender?.id ?? "?"} in ${space.id}: ${text}`);
  await space.send(`echo: ${text}`);
}
