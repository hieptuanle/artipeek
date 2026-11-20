// APNs sender for the iOS app: token-based auth (ES256 JWT from a .p8 key), HTTP/2, one session per host.
// A device token belongs to one environment (a development build: sandbox; TestFlight/App Store: production), so each
// send goes to that token's host. `origin` replaces both hosts (tests only: a local fake APNs over cleartext http2).
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import http2 from "node:http2";

export type ApnsConfig = { keyPath: string; keyId: string; teamId: string; bundleId: string; origin?: string };
export type Env = "sandbox" | "production";
export type SendResult = { status: number; reason?: string };

const HOST: Record<Env, string> = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" };

export function createApns(cfg: ApnsConfig) {
  let jwt: { token: string; until: number } | null = null;
  function bearer(): string {
    const now = Math.floor(Date.now() / 1000);
    if (jwt && jwt.until > now) return jwt.token;
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const input = `${b64({ alg: "ES256", kid: cfg.keyId })}.${b64({ iss: cfg.teamId, iat: now })}`;
    // ieee-p1363: raw r||s, as JWT ES256 needs (not DER)
    const sig = sign("SHA256", Buffer.from(input), { key: createPrivateKey(readFileSync(cfg.keyPath, "utf8")), dsaEncoding: "ieee-p1363" });
    jwt = { token: `${input}.${sig.toString("base64url")}`, until: now + 45 * 60 }; // Apple: refresh between 20 and 60 min
    return jwt.token;
  }

  const sessions = new Map<string, http2.ClientHttp2Session>();
  function session(origin: string): http2.ClientHttp2Session {
    const s = sessions.get(origin);
    if (s && !s.closed && !s.destroyed) return s;
    const n = http2.connect(origin);
    n.on("error", (e) => console.log(`artipeek (push): APNs connection error: ${e.message}`));
    n.on("close", () => { if (sessions.get(origin) === n) sessions.delete(origin); });
    n.on("goaway", () => { if (sessions.get(origin) === n) sessions.delete(origin); });
    // an idle connection may be dropped by Apple or a NAT; a fresh one is cheap
    n.setTimeout(10 * 60_000, () => n.close());
    sessions.set(origin, n);
    return n;
  }

  function send(token: string, env: Env, payload: unknown, headers: Record<string, string> = {}): Promise<SendResult> {
    let auth: string;
    try { auth = bearer(); } catch (e) { return Promise.resolve({ status: 0, reason: `key: ${(e as Error).message}` }); }
    const origin = cfg.origin ?? HOST[env];
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: SendResult) => { if (!done) { done = true; resolve(r); } };
      let req: http2.ClientHttp2Stream;
      try {
        req = session(origin).request({
          ":method": "POST", ":path": `/3/device/${token}`,
          authorization: `bearer ${auth}`, "apns-topic": cfg.bundleId, "apns-push-type": "alert", "apns-priority": "10",
          "content-type": "application/json", ...headers,
        });
      } catch (e) { return finish({ status: 0, reason: (e as Error).message }); }
      let status = 0, body = "";
      req.setEncoding("utf8");
      req.on("response", (h) => { status = Number(h[":status"]); });
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        let reason: string | undefined;
        if (status !== 200 && body) { try { reason = JSON.parse(body).reason; } catch {} }
        // a rejected provider token: make a new one next time
        if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") jwt = null;
        finish({ status, reason });
      });
      req.on("error", (e) => finish({ status: 0, reason: e.message }));
      req.setTimeout(15_000, () => { finish({ status: 0, reason: "timeout" }); try { req.close(http2.constants.NGHTTP2_CANCEL); } catch {} });
      req.end(JSON.stringify(payload));
    });
  }

  return { send, close: () => { for (const s of sessions.values()) s.close(); sessions.clear(); } };
}

// The token is gone for good: forget it.
export const deadToken = (r: SendResult) => r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered";
