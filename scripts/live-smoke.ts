/**
 * Live smoke test against a running agent-wechat container.
 *
 * Exercises the SDK's real code path end-to-end:
 *   1. health + auth (pauses for QR login when the session is logged out)
 *   2. send a nonce text to `filehelper` (the account's own File Transfer
 *      Helper — no third party receives anything)
 *   3. read the nonce back from the message DB via the messages API
 *   4. optionally wait for a live inbound message using the provider's own
 *      pollOnce loop (send the bot a DM from your phone to exercise receive)
 *
 * Run:
 *   AGENT_WECHAT_TOKEN=$(cat ~/.config/agent-wechat/token) pnpm tsx scripts/live-smoke.ts
 *
 * Env knobs:
 *   AGENT_WECHAT_URL     base URL (default http://localhost:6174)
 *   SMOKE_RECEIVE_SECS   how long to listen for a live inbound message (default 45)
 *   SMOKE_REPLY          set to reply "echo: …" to that inbound message
 */
import { randomUUID } from "node:crypto";
import { AgentWeChatClient } from "../src/client.js";
import { ensureLoggedIn } from "../src/login.js";
import { baseline, newPollState, pollOnce, type WeChatInbound } from "../src/poll.js";
import { wechatConfigSchema } from "../src/types.js";

const log = {
  info: (m: string) => console.log(`[smoke] ${m}`),
  warn: (m: string) => console.log(`[smoke] WARN ${m}`),
  debug: (m: string) => console.log(`[smoke] debug ${m}`),
};

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const config = wechatConfigSchema.parse({
  baseUrl: process.env.AGENT_WECHAT_URL ?? "http://localhost:6174",
  token: process.env.AGENT_WECHAT_TOKEN,
  pollIntervalMs: 1500,
  groups: "include",
  downloadMedia: false,
});

const api = new AgentWeChatClient({ baseUrl: config.baseUrl, token: config.token });
let failed = false;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`[smoke] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

// 1. health + auth (pause for QR if needed)
const health = await api.health().catch((e) => ({ status: `error: ${e}` }));
check("health", health.status === "ok", `status=${health.status}`);

const selfId = await ensureLoggedIn(api, config, log);
check("login", Boolean(selfId), `loggedInUser=${selfId ?? "(unknown)"}`);

// 2. send a nonce to filehelper
const nonce = `photon-wechat-sdk smoke ${randomUUID().slice(0, 8)}`;
const sendRes = await api.sendText("filehelper", nonce);
check("send", sendRes.success === true, sendRes.error ?? nonce);

// 3. read it back from the message DB (WAL checkpoint can lag a few seconds)
let roundTrip = false;
const sendDeadline = Date.now() + 60_000;
while (Date.now() < sendDeadline && !roundTrip) {
  await delay(2500);
  const msgs = await api.listMessages("filehelper", 20).catch(() => []);
  roundTrip = msgs.some((m) => m.content.includes(nonce));
}
check("read-back", roundTrip, roundTrip ? "nonce found in filehelper history" : "nonce not visible within 60s");

// 4. optional: live inbound receive via the provider's own poll loop
const receiveSecs = Number(process.env.SMOKE_RECEIVE_SECS ?? "45");
if (receiveSecs > 0) {
  log.info(`listening ${receiveSecs}s for a live inbound message — DM the bot from another account now…`);
  const state = newPollState();
  await baseline(api, config, state, log);
  const received: WeChatInbound[] = [];
  const deadline = Date.now() + receiveSecs * 1000;
  while (Date.now() < deadline && received.length === 0) {
    await pollOnce(api, config, state, (m) => {
      received.push(m);
    }, log);
    if (received.length === 0) await delay(config.pollIntervalMs);
  }
  if (received.length > 0) {
    const m = received[0]!;
    const text = m.content.type === "text" ? m.content.text : `<${m.content.type}>`;
    check("receive", true, `from ${m.sender.id} (${m.senderName ?? "?"}) in ${m.space.id}: ${text}`);
    if (process.env.SMOKE_REPLY) {
      const reply = await api.sendText(m.space.id, `echo: ${text}`);
      check("reply", reply.success === true, reply.error ?? "echoed back");
    }
  } else {
    console.log("[smoke] SKIP receive — no inbound message arrived in the window (not a failure)");
  }
}

console.log(failed ? "[smoke] RESULT: FAIL" : "[smoke] RESULT: PASS");
process.exit(failed ? 1 : 0);
