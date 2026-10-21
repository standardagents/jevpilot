import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { authenticatedUserId, sign } from "../server/auth.js";
import { jevMiddleware } from "../server/jev.js";
import { Simulation } from "../src/simulation.js";

const secret = "test-session-secret-not-a-production-credential";
const request = (token, extra = {}) =>
  new Request("https://jevpilot.example/api/decide", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Cookie: `other=value; __Host-jevpilot=${token}` } : {}),
      ...extra,
    },
    body: JSON.stringify({ user_id: "spoofed-user", authenticated: true }),
  });

test("hosted identity comes only from a valid signed login cookie", async () => {
  const token = await sign(secret, { user_id: "verified-user" }, 60);
  assert.equal(
    await authenticatedUserId(request(token), secret),
    "verified-user",
  );
  assert.equal(
    await authenticatedUserId(
      request(null, {
        Authorization: `Bearer ${token}`,
        "X-User-Id": "verified-user",
      }),
      secret,
    ),
    null,
  );
});

test("missing, forged, expired, and wrong-purpose login cookies are rejected", async () => {
  const token = await sign(secret, { user_id: "verified-user" }, 60);
  const [payload, signature] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({
      value: { user_id: "another-user" },
      exp: Date.now() + 60000,
    }),
  ).toString("base64url");
  const invalid = [
    null,
    "not-a-session",
    `${forged}.${signature}`,
    `${payload}.${signature}.extra`,
    await sign("another-secret", { user_id: "verified-user" }, 60),
    await sign(secret, { user_id: "verified-user" }, -1),
    await sign(secret, { nonce: "oauth-state", opt_in: true }, 60),
    await sign(secret, { user_id: "../another-user" }, 60),
  ];
  for (const candidate of invalid)
    assert.equal(await authenticatedUserId(request(candidate), secret), null);
  assert.equal(await authenticatedUserId(request(token), undefined), null);
});

async function localServer(t, env = {}) {
  const middleware = jevMiddleware(env);
  const server = createServer((req, res) =>
    middleware(req, res, () => {
      res.writeHead(404);
      res.end();
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test("local status explicitly disables auth and has no demo credit account", async (t) => {
  const origin = await localServer(t, { TYPESAFE_API_KEY: "local-test-key" });
  const response = await fetch(`${origin}/api/status`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.auth_required, false);
  assert.equal(data.authenticated, false);
  assert.equal(data.configured, true);
  assert.equal(data.decision_provider, "jev");
  assert.equal(data.model, "jev-latest");
  assert.equal(data.credits, undefined);
  assert.equal(data.user, undefined);
  assert(!JSON.stringify(data).includes("local-test-key"));
  for (const path of ["/login", "/login.html?error=signin"]) {
    const login = await fetch(`${origin}${path}`, { redirect: "manual" });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get("Location"), "/");
  }
});

test("EvoLink is an explicit opt-in and cannot reuse the Jev key", async (t) => {
  const origin = await localServer(t, {
    DECISION_PROVIDER: "evolink",
    TYPESAFE_API_KEY: "jev-only-key",
  });
  const status = await (await fetch(`${origin}/api/status`)).json();
  assert.equal(status.decision_provider, "evolink");
  assert.equal(status.decision_name, "Luna");
  assert.equal(status.model, "gpt-6-luna-decisions");
  assert.equal(status.configured, false);
  assert.equal(status.pricing.input_per_million, 0.1);
  assert.equal(status.pricing.output_per_million, 0);
  assert(!JSON.stringify(status).includes("jev-only-key"));
  const response = await fetch(`${origin}/api/decide`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /EVOLINK_API_KEY/);

  const defaultOrigin = await localServer(t, {
    EVOLINK_API_KEY: "evolink-only-key",
  });
  const defaultStatus = await (
    await fetch(`${defaultOrigin}/api/status`)
  ).json();
  assert.equal(defaultStatus.decision_provider, "jev");
  assert.equal(defaultStatus.configured, false);
});

test("local EvoLink status and rejected-key errors never reveal credentials", async (t) => {
  const origin = await localServer(t, {
    DECISION_PROVIDER: "evolink",
    EVOLINK_API_KEY: "evolink-test-key",
  });
  const status = await (await fetch(`${origin}/api/status`)).json();
  assert.equal(status.configured, true);
  assert(!JSON.stringify(status).includes("evolink-test-key"));
  const clientFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url !== "https://direct.evolink.ai/v1/decisions")
      return clientFetch(url, options);
    assert.equal(options.headers.Authorization, "Bearer evolink-test-key");
    return new Response("", { status: 401 });
  });
  const response = await clientFetch(`${origin}/api/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ state: new Simulation(42).decisionState() }),
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.match(body.error, /EvoLink rejected the API key/);
  assert(!JSON.stringify(body).includes("evolink-test-key"));
});

test("local decisions need a personal Jev key, not login credentials", async (t) => {
  const origin = await localServer(t);
  const response = await fetch(`${origin}/api/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: "{}",
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /TYPESAFE_API_KEY in \.env/);
});

test("local requests reach Jev without a session and preserve rejected-key errors", async (t) => {
  const origin = await localServer(t, { TYPESAFE_API_KEY: "local-test-key" });
  const clientFetch = globalThis.fetch;
  let upstreamCalls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url !== "https://api.typesafe.ai/v1/systemone")
      return clientFetch(url, options);
    upstreamCalls++;
    assert.equal(options.headers.Authorization, "Bearer local-test-key");
    return new Response("", { status: 401 });
  });
  const options = {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ state: new Simulation(42).decisionState() }),
  };
  const response = await clientFetch(`${origin}/api/decide`, options);
  assert.equal(upstreamCalls, 1);
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /Jev rejected the API key/);
  const crossOrigin = await clientFetch(`${origin}/api/decide`, {
    ...options,
    headers: { ...options.headers, Origin: "https://another-site.example" },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(upstreamCalls, 1);
});
