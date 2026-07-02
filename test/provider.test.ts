import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentWeChatClient } from "../src/client.js";
import { deliverContent, inboundContent } from "../src/content.js";
import {
  baseline,
  messageKey,
  newPollState,
  pollOnce,
  resolveSenderId,
  type WeChatInbound,
} from "../src/poll.js";
import { wechatConfigSchema } from "../src/types.js";
import { chat, MockAgentWeChat, msg } from "./mock-server.js";

const GROUP = "room123@chatroom";
const cfg = (over: Record<string, unknown> = {}) =>
  wechatConfigSchema.parse({ waitForLogin: false, downloadMedia: false, ...over });

let mock: MockAgentWeChat;
let baseUrl: string;
let api: AgentWeChatClient;

beforeEach(async () => {
  mock = new MockAgentWeChat();
  baseUrl = await mock.start();
  api = new AgentWeChatClient({ baseUrl, token: "test-token" });
});

afterEach(async () => {
  await mock.stop();
});

async function collect(
  config = cfg({ groups: "include" }),
  state = newPollState(),
): Promise<WeChatInbound[]> {
  const out: WeChatInbound[] = [];
  await pollOnce(api, config, state, (m) => {
    out.push(m);
  });
  return out;
}

describe("AgentWeChatClient", () => {
  it("reads auth status, chats and messages, and records sends", async () => {
    mock.setChats([chat({ id: "wxid_alice", name: "Alice" })]);
    mock.setMessages("wxid_alice", [msg({ chatId: "wxid_alice", content: "hi" })]);

    expect((await api.authStatus()).status).toBe("logged_in");
    expect((await api.listChats()).length).toBe(1);
    expect((await api.listMessages("wxid_alice"))[0]!.content).toBe("hi");

    await api.sendText("wxid_alice", "pong");
    expect(mock.sent).toEqual([{ chatId: "wxid_alice", text: "pong" }]);
  });
});

describe("per-person separation", () => {
  it("keeps distinct senders in a group as separate people (never the room id)", async () => {
    mock.setChats([chat({ id: GROUP, name: "Room", lastMsgLocalId: 2 })]);
    mock.setMessages(GROUP, [
      // newest-first, as the real server returns
      msg({ chatId: GROUP, localId: 2, sender: "wxid_bob", content: "from bob" }),
      msg({ chatId: GROUP, localId: 1, sender: "wxid_alice", content: "from alice" }),
    ]);

    const got = await collect();
    expect(got.map((m) => m.sender.id).sort()).toEqual(["wxid_alice", "wxid_bob"]);
    // never collapses onto the room id
    expect(got.some((m) => m.sender.id === GROUP)).toBe(false);
    // emitted oldest-first
    expect(got.map((m) => m.sender.id)).toEqual(["wxid_alice", "wxid_bob"]);
    expect(got.every((m) => m.space.id === GROUP)).toBe(true);
    expect(got.every((m) => m.chatType === "group")).toBe(true);
  });

  it("uses the chat id as the sender for a DM", async () => {
    mock.setChats([chat({ id: "wxid_alice", name: "Alice", lastMsgLocalId: 5 })]);
    mock.setMessages("wxid_alice", [
      msg({ chatId: "wxid_alice", localId: 5, sender: "wxid_alice", content: "hey" }),
    ]);
    const got = await collect();
    expect(got).toHaveLength(1);
    expect(got[0]!.sender.id).toBe("wxid_alice");
    expect(got[0]!.chatType).toBe("dm");
  });

  it("drops a group message with no resolvable sender", () => {
    expect(resolveSenderId(msg({ chatId: GROUP, sender: undefined }), true)).toBeNull();
    expect(resolveSenderId(msg({ chatId: "wxid_x", sender: undefined }), false)).toBe(
      "wxid_x",
    );
  });
});

describe("dedupe and activity", () => {
  it("does not re-emit unchanged messages across polls", async () => {
    mock.setChats([chat({ id: "wxid_alice", name: "Alice", lastMsgLocalId: 1 })]);
    mock.setMessages("wxid_alice", [msg({ chatId: "wxid_alice", localId: 1 })]);

    const state = newPollState();
    const first = await collect(cfg({ groups: "include" }), state);
    const second = await collect(cfg({ groups: "include" }), state);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("emits only newly-arrived messages after activity changes", async () => {
    mock.setChats([chat({ id: "wxid_alice", name: "Alice", lastMsgLocalId: 1 })]);
    mock.setMessages("wxid_alice", [msg({ chatId: "wxid_alice", localId: 1, content: "one" })]);

    const state = newPollState();
    expect(await collect(cfg({ groups: "include" }), state)).toHaveLength(1);

    // a new message arrives; the chat's activity marker changes
    mock.setChats([chat({ id: "wxid_alice", name: "Alice", lastMsgLocalId: 2 })]);
    mock.setMessages("wxid_alice", [
      msg({ chatId: "wxid_alice", localId: 2, content: "two" }),
      msg({ chatId: "wxid_alice", localId: 1, content: "one" }),
    ]);
    const next = await collect(cfg({ groups: "include" }), state);
    expect(next.map((m) => (m.content as { text: string }).text)).toEqual(["two"]);
  });

  it("baseline suppresses pre-existing history", async () => {
    mock.setChats([chat({ id: "wxid_alice", name: "Alice", lastMsgLocalId: 1 })]);
    mock.setMessages("wxid_alice", [msg({ chatId: "wxid_alice", localId: 1 })]);
    const state = newPollState();
    await baseline(api, cfg(), state);
    expect(await collect(cfg({ groups: "include" }), state)).toHaveLength(0);
  });

  it("builds stable de-dupe keys", () => {
    expect(messageKey(msg({ chatId: "c", localId: 7 }))).toBe("c:l:7");
    expect(messageKey(msg({ chatId: "c", localId: 0, serverId: 9 }))).toBe("c:s:9");
  });
});

describe("filtering", () => {
  it("excludes self messages", async () => {
    mock.setChats([chat({ id: "wxid_alice", lastMsgLocalId: 1 })]);
    mock.setMessages("wxid_alice", [
      msg({ chatId: "wxid_alice", localId: 1, isSelf: true, content: "mine" }),
    ]);
    expect(await collect()).toHaveLength(0);
  });

  it("excludes groups by default, includes on mention with mentionsOnly", async () => {
    mock.setChats([chat({ id: GROUP, lastMsgLocalId: 2 })]);
    mock.setMessages(GROUP, [
      msg({ chatId: GROUP, localId: 2, sender: "wxid_bob", isMentioned: true, content: "@bot" }),
      msg({ chatId: GROUP, localId: 1, sender: "wxid_alice", content: "chatter" }),
    ]);

    expect(await collect(cfg({ groups: "exclude" }))).toHaveLength(0);

    const mentioned = await collect(cfg({ groups: "mentionsOnly" }), newPollState());
    expect(mentioned.map((m) => m.sender.id)).toEqual(["wxid_bob"]);
  });
});

describe("content mapping", () => {
  it("maps inbound text to Spectrum text content", async () => {
    const content = await inboundContent(api, msg({ chatId: "c", content: "yo" }), cfg());
    expect(content).toMatchObject({ type: "text", text: "yo" });
  });

  it("skips system and recalled messages", async () => {
    expect(await inboundContent(api, msg({ chatId: "c", type: 10000 }), cfg())).toBeNull();
    expect(await inboundContent(api, msg({ chatId: "c", type: 10002 }), cfg())).toBeNull();
  });

  it("delivers text via the send API", async () => {
    await deliverContent(api, "wxid_alice", { type: "text", text: "hi" } as never, cfg());
    expect(mock.sent).toEqual([{ chatId: "wxid_alice", text: "hi" }]);
  });

  it("rejects reactions as unsupported", async () => {
    await expect(
      deliverContent(api, "wxid_alice", { type: "reaction", emoji: "❤️" } as never, cfg()),
    ).rejects.toThrow(/reaction|unsupported/i);
  });
});
