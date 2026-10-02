// Shared gateway core: auth, model resolution, token rotation, upstream call.
// Used by both OpenAI /v1/chat/completions and Anthropic /v1/messages routes.

export type GatewayResult =
  | { kind: "error"; status: number; body: any }
  | { kind: "upstream_error"; status: number; body: string; contentType: string }
  | { kind: "stream"; body: ReadableStream<Uint8Array>; startedAt: number; ctx: FinalizeCtx }
  | { kind: "json"; text: string; usage: { prompt_tokens: number; completion_tokens: number }; startedAt: number };

export interface FinalizeCtx {
  sb: any;
  apiKey: any;
  provider: any;
  model: any;
  token: any;
  attemptStart: number;
}

// In-memory cache for decrypted provider secrets. Providers rarely change;
// decrypting AES-GCM on every request adds real latency at scale. Key on
// provider.id + updated_at so admin edits invalidate automatically.
const providerSecretCache = new Map<
  string,
  { baseUrl: string; extraHeaders: Record<string, string> }
>();

// ---------------------------------------------------------------------------
// TTL caches (fix #6 — heavy DB fan-out per request on Cloudflare)
// Every Supabase round-trip from a Worker edge costs ~50-150ms of TTFB.
// Models, providers and provider token LISTS change rarely (admin edits only),
// so they are served from an in-isolate cache with short TTLs. Cooldown state
// is re-evaluated live from cooldown_until timestamps at request time.
// SECURITY: api_keys, IP bans, suspensions, freezes and the per-request RPM
// reservation are NEVER cached — they must stay fresh on every request.
// ---------------------------------------------------------------------------
const modelCache = new Map<string, { row: any; until: number }>();
const providerCache = new Map<string, { row: any; until: number }>();
const tokensCache = new Map<string, { rows: any[]; until: number }>();
const MODEL_TTL = 60_000;
const PROVIDER_TTL = 60_000;
const TOKENS_TTL = 30_000;

function mapGetFresh(m: Map<string, any>, k: string): any {
  const hit = m.get(k);
  if (!hit) return null;
  if (hit.until <= Date.now()) { m.delete(k); return null; }
  return hit;
}

// Global per-user token total (gw_get_user_token_total) — soft limit gauge.
// 20s cache: worst case a user slightly overshoots their token cap for 20s,
// in exchange for two fewer sequential round-trips on EVERY request.
const userTokenTotalCache = new Map<string, { total: number; until: number }>();
async function getUserTokenTotal(sb: any, userId: string): Promise<number> {
  const hit = userTokenTotalCache.get(userId);
  if (hit && hit.until > Date.now()) return hit.total;
  let total = 0;
  try {
    const { data } = await sb.rpc("gw_get_user_token_total" as any, { _user_id: userId });
    total = Number(data ?? 0);
  } catch {}
  if (userTokenTotalCache.size > 256) userTokenTotalCache.clear();
  userTokenTotalCache.set(userId, { total, until: Date.now() + 20_000 });
  return total;
}

// ---------------------------------------------------------------------------
// Authenticated owner bypass ("owner API pe limit na lage, user pe rahe")
// A key gets user-side BLOCKING limits lifted ONLY if its *authenticated*
// owner is an admin/owner in the database (admins table or user_roles
// owner|admin). Hard security properties:
//   - No client-controlled header can grant the bypass.
//   - Regular user keys are completely unaffected: spend guard, input/output
//     caps, global token limit, cooldowns, daily/monthly token caps, RPM
//     reservation, IP strikes and bans all still apply to them as before.
//   - Owner usage is STILL debited and logged — only the blocking limits go.
//   - Result cached 30s per user, so revoking owner rights takes effect ≤30s.
// ---------------------------------------------------------------------------
const ownerCache = new Map<string, { owner: boolean; until: number }>();
const OWNER_TTL = 30_000;

async function isOwnerUser(sb: any, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const hit = ownerCache.get(userId);
  if (hit && hit.until > Date.now()) return hit.owner;
  let owner = false;
  try {
    const [adm, role] = await Promise.all([
      sb.from("admins").select("id").eq("id", userId).maybeSingle(),
      sb.from("user_roles").select("id").eq("user_id", userId).in("role", ["owner", "admin"]).limit(1),
    ]);
    owner = !!adm?.data || !!(role?.data && role.data.length > 0);
  } catch {}
  if (ownerCache.size > 256) ownerCache.clear();
  ownerCache.set(userId, { owner, until: Date.now() + OWNER_TTL });
  return owner;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Race the first upstream byte against a deadline. On timeout the reader is
// cancelled so the socket is released before failing over to the next token.
function firstByteOrTimeout(reader: any, ms: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { reader.cancel().catch(() => {}); } catch {}
      reject(new Error(`no first byte within ${ms}ms`));
    }, ms);
    reader.read().then(
      (r: any) => { clearTimeout(timer); resolve(r); },
      (e: any) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ---------------------------------------------------------------------------
// Fast upstream-model masking (fix #7 — split().join() per chunk)
// A precompiled RegExp (cached per upstream model id) replaces every
// occurrence of the upstream id with the public alias in ONE pass.
// ---------------------------------------------------------------------------
const maskRegexCache = new Map<string, RegExp | null>();
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function maskRegexFor(model: any): RegExp | null {
  const up = String(model?.upstream_model ?? "");
  const pub = String(model?.display_name ?? "");
  if (!up || !pub || up === pub) return null;
  let re = maskRegexCache.get(up);
  if (re === undefined) {
    re = new RegExp(escapeRegExp(up), "g");
    if (maskRegexCache.size > 64) maskRegexCache.clear();
    maskRegexCache.set(up, re);
  }
  return re;
}

export async function runGateway(request: Request, openaiBody: any): Promise<GatewayResult> {
  const clientIp =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    request.headers.get("x-real-ip") ||
    "";

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const auth = request.headers.get("authorization") ?? request.headers.get("x-api-key") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const rawKey = (m ? m[1] : auth).trim();
  if (!rawKey) {
    if (clientIp) { try { await supabaseAdmin.rpc("gw_record_ip_strike", { _ip: clientIp, _reason: "missing_key" }); } catch {} }
    return { kind: "error", status: 401, body: { error: { message: "Missing bearer token", type: "auth_error" } } };
  }

  const { hashApiKey, decryptSecret } = await import("@/lib/crypto.server");

  // Run ip-ban check and api-key lookup in parallel — they don't depend
  // on each other. Cuts one round-trip off the hot path.
  const keyHash = hashApiKey(rawKey);
  const [banRes, keyRes] = await Promise.all([
    clientIp
      ? (async () => {
          try { return await supabaseAdmin.rpc("gw_is_ip_banned", { _ip: clientIp }); }
          catch { return { data: false }; }
        })()
      : Promise.resolve({ data: false }),
    supabaseAdmin.from("api_keys").select("*").eq("key_hash", keyHash).maybeSingle(),
  ]);
  if (banRes?.data) {
    const { data: row } = await supabaseAdmin
      .from("banned_ips").select("expires_at, reason").eq("ip", clientIp).maybeSingle();
    const retry = row?.expires_at
      ? Math.max(1, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000))
      : 3600;
    return {
      kind: "error",
      status: 403,
      body: {
        error: {
          type: "ip_banned",
          message: `Your IP has been temporarily blocked for abusive traffic. Try again in ${Math.ceil(retry / 60)} minute(s). Contact an administrator if this is a mistake.`,
          reason: row?.reason ?? "abuse",
          retry_after_seconds: retry,
          expires_at: row?.expires_at ?? null,
        },
      },
    };
  }
  const { data: apiKey, error: keyErr } = keyRes as any;
  if (keyErr) return { kind: "error", status: 500, body: { error: { message: "internal error", type: "gateway_error" } } };
  if (!apiKey || !apiKey.enabled) {
    if (clientIp) { try { await supabaseAdmin.rpc("gw_record_ip_strike", { _ip: clientIp, _reason: "invalid_key" }); } catch {} }
    return { kind: "error", status: 401, body: { error: { message: "Invalid API key", type: "auth_error" } } };
  }
  if (Number(apiKey.balance) <= 0) return { kind: "error", status: 402, body: { error: { message: "Insufficient balance", type: "billing_error" } } };

  const modelName = String(openaiBody.model ?? "").trim();
  if (!modelName) return { kind: "error", status: 400, body: { error: { message: "model is required" } } };
  // Hard allow-list. PostgREST filter strings are built from this value, so we
  // permit ONLY characters that can appear in a real model id. Anything else is
  // treated as "not found" rather than being escaped — no injection surface.
  if (modelName.length > 200 || !/^[A-Za-z0-9._:@/+\- ]+$/.test(modelName)) {
    return { kind: "error", status: 404, body: { error: { message: `Model '${modelName}' not found`, type: "invalid_request" } } };
  }
  const wantStream = !!openaiBody.stream;

  // Owner detection + global token-limit check run IN PARALLEL with the
  // lookups below, so neither adds a sequential round-trip on the hot path.
  const ownerPromise = isOwnerUser(supabaseAdmin, apiKey.user_id);
  const tokenLimitPromise = (async () => {
    if (!apiKey.user_id) return { blocked: false };
    try {
      const { data: userProfile } = await supabaseAdmin.from("profiles").select("*" as any).eq("id", apiKey.user_id).single();
      const maxLimit = Number((userProfile as any)?.max_tokens_limit ?? 0);
      if (!userProfile || !(maxLimit > 0)) return { blocked: false };
      const total = await getUserTokenTotal(supabaseAdmin, apiKey.user_id);
      return { blocked: total >= maxLimit };
    } catch { return { blocked: false }; }
  })();

  // Single query: match by display_name OR upstream_model. Cuts a second
  // round-trip on the common case where the caller passes upstream ids.
  // Also parallel with the suspended-user check. Result TTL-cached.
  const cachedModel = mapGetFresh(modelCache, modelName);
  const modelPromise = cachedModel
    ? Promise.resolve({ data: [cachedModel.row], error: null })
    : (async () =>
        supabaseAdmin
          .from("models").select("*")
          // Case-insensitive exact match (ilike without wildcards). Clients type
          // `glm-5.2` while the catalog stores `Glm-5.2`; an eq match 404'd those.
          // modelName is already restricted to a safe character allow-list above.
          .or(`display_name.ilike.${modelName},upstream_model.ilike.${modelName}`)
          .eq("enabled", true).limit(1))();
  const [modelRes, suspendedRes] = await Promise.all([
    modelPromise,
    apiKey.user_id
      ? (async () => {
          try { return await supabaseAdmin.rpc("is_user_suspended", { _user_id: apiKey.user_id }); }
          catch { return { data: false }; }
        })()
      : Promise.resolve({ data: false }),
  ]);
  const isOwner = await ownerPromise;
  if ((suspendedRes as any)?.data) {
    return { kind: "error", status: 403, body: { error: { message: "Account suspended. Contact admin.", type: "account_suspended" } } };
  }
  const isFrozen = apiKey.user_id ? await (async () => {
    try { return await supabaseAdmin.rpc("is_user_frozen" as any, { _user_id: apiKey.user_id }); }
    catch { return { data: false }; }
  })() : { data: false };
  
  if ((isFrozen as any)?.data) {
    return { kind: "error", status: 403, body: { error: { message: "Account balance frozen. Contact admin.", type: "account_frozen" } } };
  }
  if ((modelRes as any).error) return { kind: "error", status: 500, body: { error: { message: (modelRes as any).error.message } } };
  const model = (modelRes as any).data?.[0];
  if (!model) return { kind: "error", status: 404, body: { error: { message: `Model '${modelName}' not found`, type: "invalid_request" } } };
  if (!cachedModel) {
    if (modelCache.size > 128) modelCache.clear();
    modelCache.set(modelName, { row: model, until: Date.now() + MODEL_TTL });
  }

  // Fetch provider AND its tokens in parallel — tokens query filters by
  // provider_id which we already have from the model row. Cuts one full
  // round-trip off TTFB on every request. Both are TTL-cached (see above).
  const cachedProvider = mapGetFresh(providerCache, model.provider_id);
  const cachedTokens = mapGetFresh(tokensCache, model.provider_id);
  const [providerRes, tokensRes] = await Promise.all([
    cachedProvider
      ? Promise.resolve({ data: cachedProvider.row, error: null })
      : supabaseAdmin.from("providers").select("*").eq("id", model.provider_id).maybeSingle(),
    cachedTokens
      ? Promise.resolve({ data: cachedTokens.rows, error: null })
      : supabaseAdmin
          .from("provider_tokens").select("*")
          .eq("provider_id", model.provider_id).eq("enabled", true)
          .order("priority", { ascending: true })
          .order("last_used_at", { ascending: true, nullsFirst: true }),
  ]);
  const { data: provider, error: pErr } = providerRes as any;
  if (pErr || !provider) return { kind: "error", status: 500, body: { error: { message: "Provider missing" } } };
  if (!provider.enabled) return { kind: "error", status: 503, body: { error: { message: "Provider disabled" } } };
  if (!cachedProvider) {
    if (providerCache.size > 128) providerCache.clear();
    providerCache.set(model.provider_id, { row: provider, until: Date.now() + PROVIDER_TTL });
  }

  // Cache decrypted provider secrets. Keyed by id + updated_at so any
  // admin edit through the UI invalidates automatically.
  const cacheKey = `${provider.id}:${provider.updated_at ?? ""}`;
  let cached = providerSecretCache.get(cacheKey);
  if (!cached) {
    const baseUrl = decryptSecret(provider.base_url_enc).replace(/\/$/, "");
    const extraHeaders: Record<string, string> = provider.headers_enc
      ? (() => { try { return JSON.parse(decryptSecret(provider.headers_enc)); } catch { return {}; } })()
      : {};
    cached = { baseUrl, extraHeaders };
    if (providerSecretCache.size > 64) providerSecretCache.clear();
    providerSecretCache.set(cacheKey, cached);
  }
  const { baseUrl, extraHeaders } = cached;

  const nowIso = new Date().toISOString();
  const keyless = provider.requires_auth === false;
  let usable: any[] = [];
  if (keyless) {
    // Synthetic pseudo-token — no auth header, no per-token balance tracking.
    usable = [{ id: "__keyless__", api_key_enc: null, balance: Number.MAX_SAFE_INTEGER, requests_today: 0, requests_this_month: 0 }];
  } else {
    const { data: tokens, error: tErr } = tokensRes as any;
    if (tErr) return { kind: "error", status: 500, body: { error: { message: tErr.message } } };
    if (!cachedTokens && tokens) {
      if (tokensCache.size > 128) tokensCache.clear();
      tokensCache.set(model.provider_id, { rows: tokens, until: Date.now() + TOKENS_TTL });
    }
    usable = (tokens ?? []).filter((t: any) => {
      // Authenticated owners bypass gateway-side token throttles (cooldown,
      // daily/monthly caps, token balance). Upstream provider limits remain
      // the final guard and the failover loop still rotates on 429/5xx.
      if (isOwner) return true;
      if (t.cooldown_until && t.cooldown_until > nowIso) return false;
      if (t.daily_limit && t.requests_today >= t.daily_limit) return false;
      if (t.monthly_limit && t.requests_this_month >= t.monthly_limit) return false;
      if (Number(t.balance) <= 0) return false;
      return true;
    });
    if (usable.length === 0) {
      if (isOwner && (tokens ?? []).length > 0) {
        usable = tokens;
      } else {
        return { kind: "error", status: 429, body: { error: { message: "No available tokens (all cooling / exhausted)", type: "rate_limit" } } };
      }
    }

    // Proactive load balancing: compute current-minute usage per token
    // (window resets after 60s) and sort by least-loaded first, so we
    // spread requests across ALL healthy tokens instead of hammering the
    // top-priority one until its provider RPM cap kicks 429s back.
    const nowMs = Date.now();
    for (const t of usable) {
      const ws = t.rpm_window_start ? new Date(t.rpm_window_start).getTime() : 0;
      t.__effRpm = (!ws || nowMs - ws >= 60_000) ? 0 : (t.rpm_window_count || 0);
    }
    usable.sort((a: any, b: any) => {
      if (a.priority !== b.priority) return (a.priority ?? 100) - (b.priority ?? 100);
      if (a.__effRpm !== b.__effRpm) return a.__effRpm - b.__effRpm;
      const la = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
      const lb = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
      return la - lb;
    });
  }

  const upstreamBody = { ...openaiBody, model: model.upstream_model };

  // ===== Pre-flight spend + size guard =====
  // Balance was previously only checked for "> 0", and cost was debited AFTER
  // the call. That let a key holding $0.01 push a multi-hundred-thousand-token
  // prompt and run up a huge upstream bill before the debit ever landed.
  // We now estimate the worst-case cost BEFORE touching the provider and
  // reject anything the key cannot actually afford.
  const estInTok = estimatePromptTokens(openaiBody);
  const maxInCap = Number(provider.max_input_tokens || 0);
  if (!isOwner && maxInCap > 0 && estInTok > maxInCap) {
    return { kind: "error", status: 413, body: { error: { message: `Prompt too large: ~${estInTok} tokens exceeds the ${maxInCap} token limit for this model.`, type: "invalid_request" } } };
  }
  const maxOutCap = Number(provider.max_output_tokens || 0);
  if (!isOwner && maxOutCap > 0) {
    const requested = Number(upstreamBody.max_tokens || 0);
    upstreamBody.max_tokens = requested > 0 ? Math.min(requested, maxOutCap) : maxOutCap;
  }
  const inPrice = Number(model.input_cost_per_1m ?? model.user_cost_per_1m ?? 0);
  const outPrice = Number(model.output_cost_per_1m ?? model.user_cost_per_1m ?? 0);
  // Assume the model will emit up to max_tokens (or a 4k default) of output.
  const assumedOut = Number(upstreamBody.max_tokens || 0) > 0 ? Number(upstreamBody.max_tokens) : 4096;
  const worstCost =
    (estInTok / 1_000_000) * inPrice +
    (assumedOut / 1_000_000) * outPrice +
    Number(model.request_cost ?? 0);
  // Authenticated owners are exempt from the BLOCKING pre-flight checks
  // (their balance may go negative), but bumpUsage still debits and logs real
  // spend. The zero-balance gate lives here too — user-side blocking limits
  // must never apply to a DB-verified owner.
  if (!isOwner && Number(apiKey.balance) <= 0) {
    return { kind: "error", status: 402, body: { error: { message: "Insufficient balance", type: "billing_error" } } };
  }
  if (!isOwner && worstCost > Number(apiKey.balance)) {
    return {
      kind: "error",
      status: 402,
      body: {
        error: {
          type: "billing_error",
          message: `Insufficient balance for this request. Estimated cost $${worstCost.toFixed(4)}, available $${Number(apiKey.balance).toFixed(4)}. Shorten the prompt, lower max_tokens, or top up.`,
        },
      },
    };
  }

  // Check global token limit (already resolved in parallel above).
  const limitRes = await tokenLimitPromise;
  if (!isOwner && limitRes.blocked) {
    return { kind: "error", status: 403, body: { error: { message: "Global token limit reached for this account.", type: "limit_exceeded" } } };
  }

  // OpenAI-compatible streaming does NOT emit `usage` unless the client opts in.
  // Without this, prompt/completion/reasoning tokens all come back as 0 and the
  // dashboard shows nothing for streamed (Claude Code / OpenAI SDK stream) calls.
  if (upstreamBody.stream) {
    upstreamBody.stream_options = { ...(upstreamBody.stream_options ?? {}), include_usage: true };
  }
  const attempts: any[] = [];

  const providerRpm = Number(provider.rpm_limit || 0);
  // Try to atomically reserve a per-minute slot on each token in order.
  // If all are at cap, wait for the soonest window to reset (bounded ≤2s)
  // and retry once — user never sees a 429 as long as any token can free up.
  let reservedToken: any = null;
  const tryReserve = async () => {
    if (keyless) { reservedToken = usable[0]; return true; }
    // Authenticated owners skip the gateway-side per-minute reservation;
    // the upstream provider's own limits + failover still protect the tokens.
    if (isOwner) { reservedToken = usable[0]; return true; }
    for (const t of usable) {
      const { data: ok } = await supabaseAdmin.rpc("gw_reserve_token_slot", {
        _id: t.id, _rpm_limit: providerRpm,
      });
      if (ok) { reservedToken = t; return true; }
    }
    return false;
  };
  if (!(await tryReserve())) {
    // Everyone at cap. Wait until the earliest window rolls over.
    let waitMs = 60_000;
    const nowMs = Date.now();
    for (const t of usable) {
      const ws = t.rpm_window_start ? new Date(t.rpm_window_start).getTime() : nowMs;
      waitMs = Math.min(waitMs, Math.max(50, 60_000 - (nowMs - ws) + 25));
    }
    if (waitMs <= 2000) {
      await new Promise((r) => setTimeout(r, waitMs));
      await tryReserve();
    }
  }
  if (!reservedToken) {
    return { kind: "error", status: 429, body: { error: { message: "All provider tokens at per-minute cap. Add another token or lower load.", type: "rate_limit" } } };
  }
  // Put reserved first, keep rest as fallbacks for upstream errors.
  // Keep a broken provider from consuming the Worker's entire subrequest
  // budget when an account has a large number of configured tokens.
  const ordered = [reservedToken, ...usable.filter((x) => x !== reservedToken)].slice(0, 8);

  for (const t of ordered) {
    const tokenKey = t.api_key_enc ? decryptSecret(t.api_key_enc) : "";
    const url = baseUrl + "/chat/completions";
    const attemptStart = Date.now();
    let res: Response;
    try {
      const authHeaders: Record<string, string> = tokenKey ? { Authorization: `Bearer ${tokenKey}` } : {};
      // Never impose an artificial generation deadline. Reasoning and agentic
      // requests can legitimately take many minutes before the upstream sends
      // response headers. Aborting here discarded valid, billable work and was
      // the exact cause of the repeated 60-second Claude Code failures.
      res = await fetch(url, {
        method: "POST",
        // Propagate an explicit client disconnect upstream. This is not an
        // artificial timeout, so long-running generations are still allowed.
        signal: request.signal,
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
          ...(upstreamBody.stream ? { Accept: "text/event-stream" } : {}),
          ...extraHeaders,
        },
        body: JSON.stringify(upstreamBody),
      });
    } catch (e: any) {
      // Do not fail over after the caller has gone away. Retrying a cancelled
      // generation would keep spending provider credits with nobody to receive
      // the result.
      if (request.signal.aborted) {
        return { kind: "error", status: 499, body: { error: { message: "Request cancelled by client", type: "request_cancelled" } } };
      }
      attempts.push({ reason: "network" });
      if (t.id !== "__keyless__") await cooldownToken(supabaseAdmin, t.id, 30, "network");
      await logError(supabaseAdmin, { provider, model, token: t, status: null, message: "Provider connection failed", response: "", latency: Date.now() - attemptStart, result: "failover" });
      await Promise.allSettled([
        logUsage(supabaseAdmin, { apiKey, provider, model, token: t, cost: 0, inTok: 0, outTok: 0, latency: Date.now() - attemptStart, success: false }),
        bumpUsage(supabaseAdmin, t, 0, 0, apiKey),
      ]);
      continue;
    }

    if (res.status === 429 || res.status === 402 || res.status === 401 || res.status === 403) {
      const detail = sanitizeUpstream(await res.text());
      attempts.push({ status: res.status });
      let secs = res.status === 429 ? 20 : 300;
      if (res.status === 429) {
        const ra = res.headers.get("retry-after");
        if (ra) {
          const n = Number(ra);
          if (Number.isFinite(n) && n > 0 && n < 600) secs = Math.ceil(n);
        }
      }
      if (t.id !== "__keyless__") await cooldownToken(supabaseAdmin, t.id, secs, res.status === 429 ? "rate_limited" : "unhealthy");
      await logError(supabaseAdmin, { provider, model, token: t, status: res.status, message: describeUpstream(res.status, detail), response: detail, latency: Date.now() - attemptStart, result: "failover" });
      await Promise.allSettled([
        logUsage(supabaseAdmin, { apiKey, provider, model, token: t, cost: 0, inTok: 0, outTok: 0, latency: Date.now() - attemptStart, success: false }),
        bumpUsage(supabaseAdmin, t, 0, 0, apiKey),
      ]);
      continue;
    }
    if (res.status >= 500) {
      const detail = sanitizeUpstream(await res.text());
      attempts.push({ status: res.status });
      if (t.id !== "__keyless__") await cooldownToken(supabaseAdmin, t.id, 15, "unhealthy");
      await logError(supabaseAdmin, { provider, model, token: t, status: res.status, message: describeUpstream(res.status, detail), response: detail, latency: Date.now() - attemptStart, result: "failover" });
      await Promise.allSettled([
        logUsage(supabaseAdmin, { apiKey, provider, model, token: t, cost: 0, inTok: 0, outTok: 0, latency: Date.now() - attemptStart, success: false }),
        bumpUsage(supabaseAdmin, t, 0, 0, apiKey),
      ]);
      continue;
    }
    if (res.status >= 400) {
      const raw = await res.text();
      const detail = sanitizeUpstream(raw);
      // A 404 (or an empty-bodied 4xx) from an OpenAI-compatible upstream almost
      // always means THIS token has no access to the model / is dead — not that
      // the request is bad. Cool the token down and fail over to the next one;
      // only surface the error if every token responds the same way.
      if ((res.status === 404 || !raw.trim()) && ordered.length > 1) {
        // NOTE: 404 here means "this token's account has no access to THIS
        // model" — the token is still perfectly healthy for other models,
        // so we do NOT cool it down. Just skip to the next token.
        attempts.push({ status: res.status });
        await logError(supabaseAdmin, { provider, model, token: t, status: res.status, message: describeUpstream(res.status, detail), response: detail, latency: Date.now() - attemptStart, result: "failover" });
        await Promise.allSettled([
          logUsage(supabaseAdmin, { apiKey, provider, model, token: t, cost: 0, inTok: 0, outTok: 0, latency: Date.now() - attemptStart, success: false }),
          bumpUsage(supabaseAdmin, t, 0, 0, apiKey),
        ]);
        continue;
      }
      await bumpUsage(supabaseAdmin, t, 0, 0, apiKey);
      await logError(supabaseAdmin, { provider, model, token: t, status: res.status, message: describeUpstream(res.status, detail), response: detail, latency: Date.now() - attemptStart, result: "returned_to_client" });
      await logUsage(supabaseAdmin, { apiKey, provider, model, token: t, cost: 0, inTok: 0, outTok: 0, latency: Date.now() - attemptStart, success: false });
      return { kind: "upstream_error", status: res.status, body: detail, contentType: res.headers.get("content-type") ?? "application/json" };
    }

    const isSSE = wantStream && (res.headers.get("content-type") ?? "").includes("text/event-stream");
    if (isSSE && res.body) {
      // FIRST-BYTE PROBE (fix #5 pre-stream half). Previously a dead upstream
      // was committed blindly: its death became a silent `data: [DONE]`, so
      // the client got an EMPTY "successful" stream — OpenClaw/Claude Code
      // showed a blank response with no retry. Now the upstream must prove
      // itself with one byte before we commit; otherwise we fail over to the
      // next token exactly like a 429/5xx. 60s budget: reasoning models may
      // legitimately take long before the first byte.
      const reader = res.body.getReader();
      let first: any;
      try {
        first = await firstByteOrTimeout(reader, 60_000);
      } catch (e: any) {
        if (request.signal.aborted) {
          return { kind: "error", status: 499, body: { error: { message: "Request cancelled by client", type: "request_cancelled" } } };
        }
        attempts.push({ reason: "no_first_byte" });
        if (t.id !== "__keyless__") await cooldownToken(supabaseAdmin, t.id, 15, "unhealthy");
        await logError(supabaseAdmin, { provider, model, token: t, status: null, message: "Upstream stalled before first byte", response: "", latency: Date.now() - attemptStart, result: "failover" });
        await Promise.allSettled([
          logUsage(supabaseAdmin, { apiKey, provider, model, token: t, cost: 0, inTok: 0, outTok: 0, latency: Date.now() - attemptStart, success: false }),
          bumpUsage(supabaseAdmin, t, 0, 0, apiKey),
        ]);
        continue;
      }
      if (first.done) {
        attempts.push({ reason: "empty_stream" });
        continue;
      }
      // Committed: one pull-based resilient stream replaces the old
      // resilient+meter pipe chain (fixes #1 #3 + the mid-stream half of #5).
      const clientStream = createResilientSSEStream({
        reader, first, request, supabaseAdmin, apiKey, provider, model, token: t, attemptStart,
      });
      return { kind: "stream", body: clientStream, startedAt: attemptStart, ctx: { sb: supabaseAdmin, apiKey, provider, model, token: t, attemptStart } };
    }

    const rawText = await res.text();
    // The upstream echoes its OWN model id (e.g. "z-ai/glm-5.2") back in the
    // response. Returning that tells any caller exactly which vendor/model sits
    // behind a Silence alias — the first step to going around the gateway.
    // Rewrite it to the public display name before it ever leaves the worker.
    const text = maskUpstreamModel(rawText, model);
    let usage = { prompt_tokens: 0, completion_tokens: 0 };
    let reasoningTok = 0;
    try {
      const j = JSON.parse(text);
      const u = j?.usage ?? {};
      usage = { prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0 };
      reasoningTok = u?.completion_tokens_details?.reasoning_tokens ?? 0;
      // Some providers report reasoning separately from completion_tokens; fold it in.
      if (reasoningTok && usage.completion_tokens < reasoningTok) {
        usage.completion_tokens += reasoningTok;
      }
    } catch {}
    const inCost = (usage.prompt_tokens / 1_000_000) * Number(model.input_cost_per_1m ?? model.user_cost_per_1m ?? 0);
    const outCost = (usage.completion_tokens / 1_000_000) * Number(model.output_cost_per_1m ?? model.user_cost_per_1m ?? 0);
    const cost = inCost + outCost + Number(model.request_cost ?? 0);
    // Parallelize the two accounting writes — they're independent.
    await Promise.all([
      bumpUsage(supabaseAdmin, t, cost, usage.prompt_tokens + usage.completion_tokens, apiKey),
      logUsage(supabaseAdmin, { apiKey, provider, model, token: t, cost, inTok: usage.prompt_tokens, outTok: usage.completion_tokens, latency: Date.now() - attemptStart, success: true }),
      t.id !== "__keyless__" ? markUsed(supabaseAdmin, t.id) : Promise.resolve(),
    ]);
    return { kind: "json", text, usage, startedAt: attemptStart };
  }

  return {
    kind: "error",
    status: 502,
    body: {
      error: {
        message: "All upstream capacity is currently unavailable",
        type: "upstream_error",
        attempts: attempts.length,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Resilient SSE stream (fixes #1 #3 #4 #5 + the mid-stream cutoff "jugaad")
// Replaces the old createResilientUpstreamStream + createMeterTransform pipe.
// Failure-mode matrix:
//
//  - FIX #1: the usage parser keeps a partial-line buffer, and the final
//    partial line without a trailing newline is ALSO parsed at stream end —
//    a truncated upstream can no longer silently drop the last usage frame.
//  - FIX #3 (backpressure): PULL-based. Upstream is read only when the client
//    actually consumes, so a slow client can never balloon worker memory.
//  - FIX #4 (abort): the upstream fetch already carries request.signal; when
//    the client disconnects the next read() rejects, we cancel the upstream
//    reader, flush metering exactly once and close. No orphaned work.
//  - FIX #5 mid-stream: an upstream death emits a proper retryable OpenAI
//    SSE error frame instead of a fake `data: [DONE]` — the client SDK knows
//    the response was interrupted and can retry, instead of presenting a
//    truncated answer as complete.
//  - JUGAAD (streaming band ho jaati hai): `: ping` SSE comments every 15s
//    during upstream silence keep Cloudflare's proxy and client sockets hot
//    through long reasoning pauses. SSE comments are ignored by every
//    conformant parser and never touch the provider payload.
//  - Metering (balance debit + usage_events) runs EXACTLY once, on
//    done/error/cancel — it can never double-charge, and a partial stream is
//    billed only for the tokens actually delivered.
//  - Model-id masking: precompiled regex + carry buffer so an id split across
//    chunks is still masked (surrogate-pair safe), single pass, no
//    split().join() array allocations per chunk.
// ---------------------------------------------------------------------------
const SSE_KEEPALIVE_MS = 15_000;

function createResilientSSEStream(o: {
  reader: any; first: any; request: Request;
  supabaseAdmin: any; apiKey: any; provider: any; model: any; token: any; attemptStart: number;
}): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const { supabaseAdmin: sb, apiKey, provider, model, token, attemptStart } = o;

  let buf = "";          // partial SSE line buffer (usage parser)
  let carry = "";        // held-back tail for cross-chunk model masking
  let inTok = 0, outTok = 0, reasoningTok = 0;
  let finalized = false;
  let closed = false;
  const re = maskRegexFor(model);
  const pubName = String(model?.display_name ?? "");
  const holdBack = re ? String(model.upstream_model).length - 1 : 0;

  const processLines = (lines: string[]) => {
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;
      const payload = l.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const u = j?.usage;
        if (u) {
          if (typeof u.prompt_tokens === "number") inTok = u.prompt_tokens;
          if (typeof u.completion_tokens === "number") outTok = u.completion_tokens;
          const r = u?.completion_tokens_details?.reasoning_tokens;
          if (typeof r === "number") reasoningTok = r;
        }
      } catch {}
    }
  };
  const parseLines = (final: boolean) => {
    if (!final) {
      if (!buf.includes("\n")) return;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      processLines(lines);
    } else {
      if (buf) processLines([buf]);
      buf = "";
    }
  };

  const emitMasked = (raw: string): Uint8Array | null => {
    const out = carry + raw;
    if (!re) { carry = ""; return encoder.encode(out); }
    if (out.length <= holdBack) { carry = out; return null; }
    let emitPart = out.slice(0, out.length - holdBack);
    carry = out.slice(out.length - holdBack);
    // Never cut a UTF-16 surrogate pair in half — push a trailing high
    // surrogate back into the carry buffer.
    while (emitPart.length && emitPart.charCodeAt(emitPart.length - 1) >= 0xd800 && emitPart.charCodeAt(emitPart.length - 1) <= 0xdbff) {
      carry = emitPart[emitPart.length - 1] + carry;
      emitPart = emitPart.slice(0, -1);
    }
    return encoder.encode(emitPart.replace(re, pubName));
  };

  const finalize = async (abnormal: boolean) => {
    if (finalized) return;
    finalized = true;
    try { parseLines(true); } catch {}
    if (reasoningTok && outTok < reasoningTok) outTok += reasoningTok;
    const inCost = (inTok / 1_000_000) * Number(model.input_cost_per_1m ?? model.user_cost_per_1m ?? 0);
    const outCost = (outTok / 1_000_000) * Number(model.output_cost_per_1m ?? model.user_cost_per_1m ?? 0);
    const cost = inCost + outCost + Number(model.request_cost ?? 0);
    await Promise.allSettled([
      bumpUsage(sb, token, cost, inTok + outTok, apiKey),
      logUsage(sb, {
        apiKey, provider, model, token,
        cost, inTok, outTok,
        latency: Date.now() - attemptStart, success: !abnormal,
      }),
      token.id !== "__keyless__" ? markUsed(sb, token.id) : Promise.resolve(),
    ]);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      // First pull emits the chunk the caller already probed — minimal TTFB.
      if (o.first) {
        const f = o.first;
        (o as any).first = null;
        const text = decoder.decode(f.value, { stream: true });
        parseLines(false);
        const masked = emitMasked(text);
        if (masked) controller.enqueue(masked);
        return;
      }
      try {
        for (;;) {
          const step: any = await Promise.race([
            o.reader.read(),
            sleep(SSE_KEEPALIVE_MS).then(() => "keepalive"),
          ]);
          if (step === "keepalive") {
            // Upstream silent (long reasoning pause). Emit an SSE comment to
            // keep the connection hot through Cloudflare's proxy.
            controller.enqueue(encoder.encode(": ping\n\n"));
            continue;
          }
          const { value, done } = step;
          if (done) {
            closed = true;
            const tail = carry + decoder.decode();
            carry = "";
            if (tail) controller.enqueue(encoder.encode(re ? tail.replace(re, pubName) : tail));
            parseLines(true);
            await finalize(false);
            controller.close();
            return;
          }
          const text = decoder.decode(value, { stream: true });
          parseLines(false);
          const masked = emitMasked(text);
          if (masked) controller.enqueue(masked);
          return; // one upstream chunk per pull → downstream sets the pace
        }
      } catch (e: any) {
        // Upstream died mid-stream, or the client disconnected (request.signal
        // aborts the upstream fetch). Close gracefully with an honest,
        // retryable error frame — never a fake [DONE].
        closed = true;
        await finalize(true);
        try {
          if (!o.request.signal.aborted) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ error: { message: "Upstream stream interrupted mid-response. Safe to retry — billed only for tokens delivered.", type: "upstream_error", retryable: true } })}\n\n`,
            ));
          }
          controller.close();
        } catch {}
      }
    },
    async cancel(reason) {
      closed = true;
      try { await o.reader.cancel(reason); } catch {}
      await finalize(true);
    },
  });
}

async function cooldownToken(sb: any, id: string, secs: number, health: string) {
  const until = new Date(Date.now() + secs * 1000).toISOString();
  await sb.from("provider_tokens").update({ cooldown_until: until, health, last_used_at: new Date().toISOString() }).eq("id", id);
}

/**
 * Replace every occurrence of the upstream model id with the gateway's public
 * alias so responses never disclose the underlying vendor/model.
 * Single-pass regex replace (fix #7) — the old split().join() allocated two
 * arrays per SSE chunk; the precompiled matcher allocates none.
 */
function maskUpstreamModel(text: string, model: any): string {
  const up = String(model?.upstream_model ?? "");
  const pub = String(model?.display_name ?? "");
  if (!up || !pub || up === pub || !text.includes(up)) return text;
  const re = maskRegexFor(model);
  return re ? text.replace(re, pub) : text;
}

/**
 * Cheap, dependency-free upper-bound estimate of prompt tokens.
 * ~4 chars per token is the standard heuristic; we round up so the pre-flight
 * spend guard errs on the side of protecting the balance.
 */
export function estimatePromptTokens(body: any): number {
  let chars = 0;
  const walk = (v: any) => {
    if (v == null) return;
    if (typeof v === "string") { chars += v.length; return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (typeof v === "object") { for (const k of Object.keys(v)) walk(v[k]); return; }
    chars += String(v).length;
  };
  walk(body?.messages);
  walk(body?.system);
  walk(body?.tools);
  return Math.ceil(chars / 4) + 8;
}
async function markUsed(sb: any, id: string) {
  await sb.from("provider_tokens").update({ last_used_at: new Date().toISOString(), health: "healthy" }).eq("id", id);
}
async function bumpUsage(sb: any, token: any, cost: number, totalTokens: number, apiKey: any) {
  // Use a transaction-like approach by parallelizing, but we MUST ensure the API key
  // balance is updated correctly.
  const writes = [];
  if (token.id !== "__keyless__") {
    writes.push(sb.rpc("gw_debit_provider_token", { _id: token.id, _cost: cost }));
  }
  if (apiKey?.id) {
    // If cost or tokens is 0 (e.g. error), we still record the request count
    writes.push(sb.rpc("gw_debit_api_key", { _id: apiKey.id, _cost: cost, _tokens: totalTokens }));
    // Also update global aggregate tokens in profile if needed (already handled by gw_debit_api_key which should increment profile totals if designed that way, 
    // but the migration added total_tokens to api_keys, so gw_debit_api_key handles it per key. 
    // The profile max check uses gw_get_user_token_total which sums these.)
  }
  
  // Update global stats
  writes.push(sb.rpc("gw_update_global_stats" as any, { _cost: cost, _tokens: totalTokens }));

  await Promise.allSettled(writes);
}

// Strip common secret-looking patterns from upstream error bodies before
// forwarding to the caller. Prevents leaking upstream tokens, urls, keys.
function sanitizeUpstream(text: string): string {
  if (!text) return text;
  return text
    .replace(/sk-[A-Za-z0-9_\-]{16,}/g, "sk-***REDACTED***")
    .replace(/Bearer\s+[A-Za-z0-9._\-]{16,}/gi, "Bearer ***REDACTED***")
    .replace(/[A-Za-z0-9._\-]{40,}\.[A-Za-z0-9._\-]{20,}/g, "***REDACTED***") // long JWT-ish
    // Provider base URLs / hostnames must never reach the caller — otherwise a
    // client can enumerate which upstream vendor sits behind Silence and then
    // attack it (or the token) directly.
    .replace(/https?:\/\/[^\s"'<>)\]}]+/gi, "***UPSTREAM***")
    // Generic long opaque credentials (api keys of other vendors: gsk_, nvapi-,
    // xai-, hf_, AIza..., anything 32+ chars of key-ish alphabet).
    .replace(/\b(?:gsk|nvapi|xai|hf|pk|rk|api|key|tok)[-_][A-Za-z0-9_\-]{16,}/gi, "***REDACTED***")
    .replace(/\bAIza[A-Za-z0-9_\-]{20,}\b/g, "***REDACTED***")
    .replace(/\b[A-Za-z0-9_\-]{48,}\b/g, "***REDACTED***")
    .slice(0, 2000);
}
// Human-readable one-liner for the admin error log.
function describeUpstream(status: number | null, detail: string): string {
  let parsed = "";
  try {
    const j = JSON.parse(detail);
    parsed = j?.error?.message ?? j?.message ?? j?.detail ?? "";
  } catch {}
  const base =
    status === 401 || status === 403 ? "Token rejected by provider (auth)" :
    status === 402 ? "Provider account out of credit" :
    status === 404 ? "Model not available for this token" :
    status === 429 ? "Provider rate limit hit" :
    status && status >= 500 ? "Provider server error" :
    status && status >= 400 ? "Provider rejected the request" :
    "Upstream failure";
  const extra = (parsed || detail || "").trim().replace(/\s+/g, " ").slice(0, 240);
  return extra ? `${base}: ${extra}` : base;
}

async function logError(sb: any, o: {
  provider: any; model: any; token: any;
  status: number | null; message: string; response: string;
  latency: number; result: "failover" | "returned_to_client";
}) {
  try {
    await sb.from("error_events").insert({
      provider_id: o.provider?.id ?? null,
      provider_name: o.provider?.name ?? null,
      key_fingerprint: o.token?.id === "__keyless__" ? "keyless" : "redacted",
      token_label: o.token?.label ?? (o.token?.id === "__keyless__" ? "keyless" : null),
      model: o.model?.display_name ?? null,
      http_status: o.status,
      message: (o.message ?? "").slice(0, 1000),
      provider_response: sanitizeUpstream(o.response ?? "").slice(0, 2000),
      final_result: o.result,
      latency_ms: o.latency,
    } as any);
  } catch {}
}

async function logUsage(sb: any, o: { apiKey: any; provider: any; model: any; token: any; cost: number; inTok: number; outTok: number; latency: number; success: boolean }) {
  try {
    await sb.from("usage_events").insert({
      api_key_id: o.apiKey.id,
      provider_id: o.provider.id,
      provider_name: o.provider.name,
      model_id: o.model.id,
      model_name: o.model.display_name,
      input_tokens: o.inTok,
      output_tokens: o.outTok,
      total_tokens: o.inTok + o.outTok,
      cost: o.cost,
      internal_cost: 0,
      latency_ms: o.latency,
      success: o.success,
    } as any);
  } catch {}
}