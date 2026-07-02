import type { AgentWeChatClient } from "./client.js";
import type { WeChatConfig } from "./types.js";

/** Thrown when the WeChat account is not logged in and cannot be recovered. */
export class WeChatNotLoggedInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeChatNotLoggedInError";
  }
}

export interface LoginLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Ensure the WeChat container is logged in, returning the logged-in wxid.
 *
 * If already logged in, returns immediately. Otherwise — when `waitForLogin`
 * is set — it surfaces the QR login surface (the VNC page, plus a best-effort
 * `/api/ws/login` nudge to render the QR) and polls until the account logs in
 * or `loginTimeoutMs` elapses.
 */
export async function ensureLoggedIn(
  client: AgentWeChatClient,
  config: WeChatConfig,
  log: LoginLogger,
): Promise<string | undefined> {
  const first = await client.authStatus();
  if (first.status === "logged_in") return first.loggedInUser;

  if (!config.waitForLogin) {
    throw new WeChatNotLoggedInError(
      `WeChat is not logged in (status: ${first.status}) and waitForLogin is disabled.`,
    );
  }

  if (config.logQr) {
    const token = client.authToken;
    const vnc = `${client.baseUrl}/vnc/${token ? `?token=${token}` : ""}`;
    log.info("WeChat is not logged in — scan the QR code to continue:");
    log.info(`  → open ${vnc} in a browser and scan with your phone's WeChat`);
  }

  const stopNudge = startLoginNudge(client, config, log);
  try {
    const deadline = Date.now() + config.loginTimeoutMs;
    while (Date.now() < deadline) {
      await delay(3000);
      const st = await client.authStatus();
      if (st.status === "logged_in") {
        log.info(`WeChat logged in as ${st.loggedInUser ?? "(unknown)"}`);
        return st.loggedInUser;
      }
    }
    throw new WeChatNotLoggedInError(
      `Timed out after ${config.loginTimeoutMs}ms waiting for WeChat login.`,
    );
  } finally {
    stopNudge();
  }
}

/**
 * Best-effort: open the `/api/ws/login` WebSocket, which drives the container's
 * login FSM so the QR actually renders, and log human-readable status events.
 * No-ops when a global `WebSocket` is unavailable (Node < 22) — the VNC page
 * still works on its own.
 */
function startLoginNudge(
  client: AgentWeChatClient,
  config: WeChatConfig,
  log: LoginLogger,
): () => void {
  const WS: typeof WebSocket | undefined =
    typeof WebSocket !== "undefined" ? WebSocket : undefined;
  if (!WS) return () => {};

  const token = client.authToken;
  const wsBase = client.baseUrl.replace(/^http/, "ws");
  const url = `${wsBase}/api/ws/login?timeoutMs=${config.loginTimeoutMs}${
    token ? `&token=${encodeURIComponent(token)}` : ""
  }`;

  let socket: WebSocket | undefined;
  try {
    socket = new WS(url);
    socket.addEventListener("message", (ev: MessageEvent) => {
      try {
        const data =
          typeof ev.data === "string" ? ev.data : String(ev.data);
        const evt = JSON.parse(data) as { type?: string; message?: string };
        if (evt.type === "qr") log.info("QR code is ready in the VNC window.");
        else if (evt.type === "phoneConfirm")
          log.info("Confirm the login on your phone.");
        else if (evt.type === "loginSuccess") log.info("Login confirmed.");
        else if (evt.type === "error" && evt.message) log.warn(evt.message);
      } catch {
        /* ignore malformed frames */
      }
    });
    socket.addEventListener("error", () => {});
  } catch {
    return () => {};
  }

  return () => {
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
  };
}
