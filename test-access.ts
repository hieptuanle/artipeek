// Test helper: a fake Cloudflare Access certs endpoint with locally generated RSA keys.
//   bun test-access.ts <port> <outdir>
// Writes test tokens to <outdir>/<name>.jwt and serves /cdn-cgi/access/certs.
// GET /rotate adds a second key (k2) to the certs, to test refetch on an unknown kid.
import { writeFileSync } from "node:fs";

const [port, out] = [Number(process.argv[2]), process.argv[3]];
const TEAM = "test.cloudflareaccess.com", AUD = "test-aud", EMAIL = "user@example.com";
const alg = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const gen = () => crypto.subtle.generateKey(alg, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
const [k1, k2, other] = await Promise.all([gen(), gen(), gen()]);

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const j = (o: unknown) => b64u(new TextEncoder().encode(JSON.stringify(o)));
async function sign(key: CryptoKey, kid: string, claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const input = `${j({ alg: "RS256", kid, typ: "JWT", ...header })}.${j(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
  return `${input}.${b64u(sig)}`;
}
const now = Math.floor(Date.now() / 1000);
const good = { aud: [AUD], email: EMAIL, iss: `https://${TEAM}`, iat: now, nbf: now, exp: now + 3600, type: "app" };
const tokens: Record<string, string> = {
  valid: await sign(k1.privateKey, "k1", good),
  badsig: await sign(other.privateKey, "k1", good),
  wrongaud: await sign(k1.privateKey, "k1", { ...good, aud: ["other-aud"] }),
  wrongiss: await sign(k1.privateKey, "k1", { ...good, iss: "https://evil.cloudflareaccess.com" }),
  expired: await sign(k1.privateKey, "k1", { ...good, exp: now - 600, nbf: now - 4000 }),
  wrongemail: await sign(k1.privateKey, "k1", { ...good, email: "someone@example.com" }),
  algnone: `${j({ alg: "none", kid: "k1" })}.${j(good)}.`,
  newkid: await sign(k2.privateKey, "k2", good),
};
for (const [n, t] of Object.entries(tokens)) writeFileSync(`${out}/${n}.jwt`, t);

const pubJwk = async (k: CryptoKeyPair, kid: string) => ({ ...(await crypto.subtle.exportKey("jwk", k.publicKey)), kid, alg: "RS256", use: "sig" });
let keys = [await pubJwk(k1, "k1")];
Bun.serve({
  hostname: "127.0.0.1", port,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/cdn-cgi/access/certs") return Response.json({ keys });
    if (p === "/rotate") { keys = [keys[0], await pubJwk(k2, "k2")]; return new Response("ok"); }
    return new Response("nf", { status: 404 });
  },
});
writeFileSync(`${out}/ready`, "1");
