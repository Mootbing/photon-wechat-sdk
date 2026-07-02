# photon-wechat-sdk

A **WeChat provider for [Spectrum](https://photon.codes/spectrum)** — bring your
agent to WeChat the same way you bring it to iMessage, WhatsApp, or Telegram.

Built with Spectrum's `definePlatform` authoring API, it wraps the
[`agent-wechat`](https://github.com/thisnick/agent-wechat) server (a headless
WeChat client with a REST API) and exposes it as a first-class platform. Every
inbound message carries the **individual sender's wxid**, so the Spectrum
runtime keeps a **separate conversation — and your agent keeps a separate
history — per person, even inside group chats**.

```ts
import { Spectrum } from "@spectrum-ts/core";
import { wechat } from "photon-wechat-sdk";

const app = await Spectrum({
  providers: [wechat.config({ token: process.env.AGENT_WECHAT_TOKEN })],
});

for await (const [space, message] of app.messages) {
  await space.send(`echo: ${message.text}`);
}
```

## Install

```sh
pnpm add photon-wechat-sdk @spectrum-ts/core
```

`@spectrum-ts/core` is a peer dependency — install it alongside the SDK.

## Prerequisites

You need a running `agent-wechat` container. It runs a real WeChat Linux client
in Docker and exposes the REST API this SDK speaks to on port `6174`.

```sh
# 1. create an API token
mkdir -p ~/.config/agent-wechat
openssl rand -hex 32 > ~/.config/agent-wechat/token

# 2. start the container (Docker Desktop / Colima)
npx @agent-wechat/cli up

# 3. log in by scanning the QR in the VNC window
#    http://localhost:6174/vnc/?token=<your-token>
```

See the [agent-wechat docs](https://thisnick.github.io/agent-wechat/) for details.
On first run the SDK detects a logged-out session and prints the VNC URL for you
to scan (`waitForLogin` is on by default).

## Quickstart

```ts
import { Spectrum } from "@spectrum-ts/core";
import { wechat } from "photon-wechat-sdk";

const app = await Spectrum({
  providers: [
    wechat.config({
      // token: reads AGENT_WECHAT_TOKEN, then ~/.config/agent-wechat/token
      baseUrl: "http://localhost:6174",
      groups: "mentionsOnly", // ignore group chatter unless the bot is @-mentioned
    }),
  ],
});

for await (const [space, message] of app.messages) {
  if (message.text) await space.send(`You said: ${message.text}`);
}
```

Run the bundled echo bot against your container:

```sh
AGENT_WECHAT_TOKEN=$(cat ~/.config/agent-wechat/token) pnpm smoke
```

## Per-person separation

WeChat delivers a group's messages on one chat id (`…@chatroom`) but tags each
with the member's own wxid. This provider maps them so that:

| WeChat scenario        | Spectrum `space.id` | Spectrum `sender.id`      |
| ---------------------- | ------------------- | ------------------------- |
| Direct message         | peer wxid           | peer wxid (= space id)    |
| Group message (Alice)  | `room@chatroom`     | `wxid_alice`              |
| Group message (Bob)    | `room@chatroom`     | `wxid_bob`                |

Because `sender.id` is always the person, the Spectrum runtime scopes memory and
transcript per human. A group message whose sender cannot be resolved is
**dropped**, never collapsed onto the room id — distinct people never merge.

## Configuration

Pass options to `wechat.config({ … })`. Every field has a default.

| Option           | Type                                       | Default                   | Description                                                             |
| ---------------- | ------------------------------------------ | ------------------------- | ---------------------------------------------------------------------- |
| `baseUrl`        | `string`                                   | `http://localhost:6174`   | agent-wechat REST base URL.                                            |
| `token`          | `string`                                   | env / token file          | Bearer token. Falls back to `AGENT_WECHAT_TOKEN`, then `~/.config/agent-wechat/token`. |
| `pollIntervalMs` | `number`                                   | `2000`                    | New-message poll interval.                                            |
| `chatLimit`      | `number`                                   | `50`                      | Recent chats scanned per poll.                                        |
| `messageLimit`   | `number`                                   | `30`                      | Recent messages read per active chat.                                |
| `groups`         | `"exclude" \| "include" \| "mentionsOnly"` | `"exclude"`               | Group-chat policy.                                                    |
| `downloadMedia`  | `boolean`                                  | `true`                    | Fetch inbound image/voice/video/file bytes.                          |
| `sendPacingMs`   | `number`                                   | `800`                     | Minimum spacing between outbound sends.                              |
| `waitForLogin`   | `boolean`                                  | `true`                    | Block startup until logged in (drives the QR flow).                 |
| `loginTimeoutMs` | `number`                                   | `300000`                  | How long to wait for QR login.                                       |
| `logQr`          | `boolean`                                  | `true`                    | Print the VNC login URL when login is required.                     |

## Feature support

| Capability                    | Status | Notes                                                        |
| ----------------------------- | ------ | ------------------------------------------------------------ |
| Receive text                  | ✅     | Polling-based.                                               |
| Receive image / voice / video | ✅     | Downloaded lazily via the media endpoint (`downloadMedia`).  |
| Receive files / app cards     | ✅     | Files as attachments; other app messages as text/custom.     |
| Per-sender group messages     | ✅     | Each member is a distinct `sender.id`.                        |
| Quoted replies (inbound)      | ✅     | Surfaced on `message.quotedReply`.                           |
| Send text                     | ✅     |                                                              |
| Send image                    | ✅     | `image/*` attachments.                                       |
| Send file                     | ✅     | Non-image attachments, vCards.                               |
| Send voice (native bubble)    | ⚠️     | Delivered as an audio **file** — no native voice bubble.     |
| Reactions / read / typing     | ❌     | Not exposed by agent-wechat; reactions throw, typing/read no-op. |
| Quote / mention on send       | ❌     | Reply body is sent as a plain message.                       |

## Limitations & responsible use

- **Polling latency.** agent-wechat has no push stream, so inbound latency is
  roughly `pollIntervalMs` plus the client's DB checkpoint (~a few seconds).
- **One session per container.** One logged-in WeChat account per `agent-wechat`
  container; run one provider instance against it.
- **Unofficial automation.** agent-wechat drives a real WeChat client. Use a
  dedicated account, keep `sendPacingMs` conservative, and respect WeChat's terms
  of service. Account-ban risk is yours to manage.

## Development

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm build       # tsup → dist (ESM + CJS + d.ts)
pnpm test        # vitest (mock agent-wechat server; no container needed)
pnpm smoke       # live send/receive against a running container
```

## License

MIT © Mootbing
