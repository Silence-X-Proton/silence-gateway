import { createFileRoute } from "@tanstack/react-router";
import { collectOpenAIStream } from "@/lib/anthropic-bridge.server";

export const Route = createFileRoute("/api/public/v1/chat/completions")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: cors() }),
      POST: async ({ request }) => {
        try {
          const cl = Number(request.headers.get("content-length") ?? "0");
          if (cl > 2_000_000) return json({ error: { message: "Request body too large (max 2MB)" } }, 413);
          return await handleChat(request);
        } catch {
          return json({ error: { message: "Internal gateway error", type: "gateway_error" } }, 500);
        }
      },
    },
  },
});

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-api-key, anthropic-version",
  } as Record<string, string>;
}
function json(body: any, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors(), ...extra },
  });
}

async function handleChat(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: { message: "Invalid JSON body" } }, 400);
  const { runGateway } = await import("@/lib/gateway-core.server");
  const started = Date.now();
  const wantStream = body.stream === true;
  // Avoid a buffered first-byte timeout for slow reasoning models while
  // preserving the caller's requested non-streaming JSON response.
  const gatewayBody = wantStream ? body : { ...body, stream: true };
  const r = await runGateway(request, gatewayBody);
  if (r.kind === "error") return json(r.body, r.status);
  if (r.kind === "upstream_error") {
    return new Response(r.body, { status: r.status, headers: { "content-type": r.contentType, ...cors() } });
  }
  if (r.kind === "stream") {
    if (!wantStream) {
      const aggregated = await collectOpenAIStream(r.body);
      return new Response(JSON.stringify(aggregated), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-silence-latency-ms": String(Date.now() - started),
          ...cors(),
        },
      });
    }
    return new Response(r.body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
        "connection": "keep-alive",
        "x-silence-latency-ms": String(Date.now() - started),
        ...cors(),
      },
    });
  }
  return new Response(r.text, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-silence-latency-ms": String(Date.now() - started),
      ...cors(),
    },
  });
}