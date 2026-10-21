import {
  authenticatedUserId,
  SESSION_COOKIE as SESSION,
  cookie,
  platform,
  readCookie,
  sign,
  verify,
} from "./auth.js";
import { decisionConfig } from "./decision-config.js";
export { PlayAccount } from "./account.js";

const STATE = "__Host-jevpilot-oauth";
const json = (data, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const redirect = (url, cookies = []) => {
  const headers = new Headers({ Location: url, "Cache-Control": "no-store" });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 303, headers });
};
async function readBody(request, max = 250000) {
  if (Number(request.headers.get("Content-Length")) > max)
    throw Object.assign(new Error("Request too large."), { status: 413 });
  const reader = request.body?.getReader();
  if (!reader)
    throw Object.assign(new Error("Request body is required."), {
      status: 400,
    });
  let length = 0;
  const chunks = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > max) {
      await reader.cancel();
      throw Object.assign(new Error("Request too large."), { status: 413 });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw Object.assign(new Error("Invalid JSON."), { status: 400 });
  }
}
async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const origin = env.APP_ORIGIN;
  if (url.origin !== origin)
    return redirect(`${origin}${url.pathname}${url.search}`);
  if (
    request.method === "POST" &&
    (request.headers.get("Origin") !== origin ||
      !request.headers.get("Content-Type")?.startsWith("application/json"))
  )
    return json({ error: "Origin or content type not allowed." }, 403);

  if (path === "/api/auth/start" && request.method === "POST") {
    const limited = await env.AUTH_LIMITER.limit({
      key: request.headers.get("CF-Connecting-IP") || "unknown",
    });
    if (!limited.success)
      return json(
        { error: "Too many sign-in attempts. Please wait a minute." },
        429,
      );
    const body = await readBody(request, 1024);
    const state = await sign(
      env.SESSION_SECRET,
      { nonce: crypto.randomUUID(), opt_in: body.early_access === true },
      600,
    );
    const data = await platform(env, "/partners/auth/start", {
      project_id: env.PLATFORM_PROJECT_ID,
      redirect_uri: `${origin}/api/auth/callback`,
      state,
    });
    if (
      typeof data.login_url !== "string" ||
      new URL(data.login_url).origin !== "https://platform.standardagents.ai"
    )
      throw new Error("Unexpected sign-in URL.");
    const response = json({ url: data.login_url });
    response.headers.append("Set-Cookie", cookie(STATE, state, 600));
    return response;
  }
  if (path === "/api/auth/callback" && request.method === "GET") {
    const token = url.searchParams.get("state");
    const state =
      token && token === readCookie(request, STATE)
        ? await verify(env.SESSION_SECRET, token)
        : null;
    const clear = cookie(STATE, "", 0);
    if (!state || !url.searchParams.get("code"))
      return redirect(`${origin}/login?error=signin`, [clear]);
    try {
      const { user } = await platform(env, "/partners/auth/exchange", {
        code: url.searchParams.get("code"),
      });
      if (
        !user ||
        typeof user.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(user.id) ||
        typeof user.email !== "string" ||
        !user.email.includes("@")
      )
        throw new Error("Invalid verified identity.");
      const identity = {
        id: user.id,
        email: user.email.trim().toLowerCase(),
        name: typeof user.name === "string" ? user.name : null,
      };
      await env.PLAY_ACCOUNTS.get(
        env.PLAY_ACCOUNTS.idFromName(user.id),
      ).initialize(identity, state.opt_in === true);
      const session = await sign(
        env.SESSION_SECRET,
        { user_id: user.id },
        30 * 86400,
      );
      return redirect(`${origin}/`, [
        cookie(SESSION, session, 30 * 86400),
        clear,
      ]);
    } catch {
      console.error("JevPilot sign-in exchange failed.");
      return redirect(`${origin}/login?error=signin`, [clear]);
    }
  }
  if (path === "/api/auth/logout" && request.method === "POST") {
    const response = json({ ok: true });
    response.headers.append("Set-Cookie", cookie(SESSION, "", 0));
    return response;
  }
  // The login and public source/assets contain no credentials or user data.
  if (path === "/login" || path === "/login.html")
    return env.ASSETS.fetch(request);
  // Protected hosted requests (including decide) must pass this gate before
  // reading its body or resolving a play account. Local Vite uses jevMiddleware.
  const userId = await authenticatedUserId(request, env.SESSION_SECRET);
  if (!userId) {
    return path.startsWith("/api/")
      ? json(
          {
            error: "Sign in to drive.",
            auth_required: true,
            authenticated: false,
          },
          401,
        )
      : redirect(`${origin}/login`);
  }
  const account = env.PLAY_ACCOUNTS.get(env.PLAY_ACCOUNTS.idFromName(userId));
  if (path === "/api/status" && request.method === "GET") {
    const config = decisionConfig(env);
    const snapshot = await account.snapshot();
    if (!snapshot)
      return json(
        {
          auth_required: true,
          authenticated: false,
          error: "Please sign in again.",
        },
        401,
      );
    return json({
      auth_required: true,
      authenticated: true,
      ...snapshot,
      configured: !!env[config.keyEnv],
      decision_provider: config.provider,
      decision_name: config.name,
      model: config.model,
      pricing: config.pricing,
    });
  }
  if (path === "/api/decide" && request.method === "POST") {
    if (!env[decisionConfig(env).keyEnv])
      return json({ error: "Jev is temporarily unavailable." }, 503);
    const body = await readBody(request);
    const response = await account.fetch(
      new Request("https://account/decide", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    const result = new Response(response.body, response);
    result.headers.set("Cache-Control", "no-store");
    return result;
  }
  if (path.startsWith("/api/")) return json({ error: "Not found." }, 404);
  const response = await env.ASSETS.fetch(request);
  const result = new Response(response.body, response);
  result.headers.set("Cache-Control", "private, no-store");
  return result;
}
export default {
  async fetch(request, env) {
    let response;
    try {
      response = await handle(request, env);
    } catch (error) {
      response = json(
        {
          error: error.status
            ? error.message
            : "JevPilot is temporarily unavailable. Please try again.",
        },
        error.status || 503,
      );
    }
    response = new Response(response.body, response);
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Frame-Options", "DENY");
    return response;
  },
};
