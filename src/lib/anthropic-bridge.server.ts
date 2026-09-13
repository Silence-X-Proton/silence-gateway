// Anthropic <-> OpenAI bridge for the Silence gateway.
// Used by both /v1/messages (top-level, what Claude Code hits) and
// /api/public/v1/messages. Handles tool_use / tool_result round-trip
// so Claude Code's Read/Bash/Edit tools work.

export function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-app, user-agent",
    "access-control-expose-headers": "x-silence-latency-ms, request-id",
  } as Record<string, string>;
}

export function jsonResp(body: any, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors(), ...extra },
  });
}

export function flattenContent(c: any): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .map((b: any) => {
      if (typeof b === "string") return b;
      if (b?.type === "text") return b.text ?? "";
      if (b?.type === "tool_result") {
        const inner = Array.isArray(b.content) ? flattenContent(b.content) : (b.content ?? "");
        return typeof inner === "string" ? inner : JSON.stringify(inner);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function anthToOpenAI(body: any) {
  const msgs: any[] = [];
  if (body.system) {
    const sys = typeof body.system === "string" ? body.system : flattenContent(body.system);
    if (sys) msgs.push({ role: "system", content: sys });
  }
  for (const m of body.messages ?? []) {
    const content = m.content;
    if (m.role === "assistant" && Array.isArray(content)) {
      const textParts: string[] = [];
      const toolCalls: any[] = [];
      for (const b of content) {
        if (b?.type === "text" && b.text) textParts.push(b.text);
        else if (b?.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      const asst: any = { role: "assistant", content: textParts.join("\n") || null };
      if (toolCalls.length) asst.tool_calls = toolCalls;
      msgs.push(asst);
      continue;
    }
    if (m.role === "user" && Array.isArray(content)) {
      const parts: any[] = [];
      for (const b of content) {
        if (b?.type === "tool_result") {
          const inner = Array.isArray(b.content) ? flattenContent(b.content) : (b.content ?? "");
          msgs.push({
            role: "tool",
            tool_call_id: b.tool_use_id,
            content: typeof inner === "string" ? inner : JSON.stringify(inner),
          });
        } else if (b?.type === "text" && b.text) {
          parts.push({ type: "text", text: b.text });
        } else if (b?.type === "image" && b.source) {
          // Anthropic image block -> OpenAI image_url block
          const s = b.source;
          let url = "";
          if (s.type === "base64" && s.data) {
            const mt = s.media_type || "image/png";
            url = `data:${mt};base64,${s.data}`;
          } else if (s.type === "url" && s.url) {
            url = s.url;
          }
          if (url) parts.push({ type: "image_url", image_url: { url } });
        } else if (typeof b === "string") {
          parts.push({ type: "text", text: b });
        }
      }
      if (parts.length) {
        // If only text parts, collapse to string for widest upstream compatibility.
        const onlyText = parts.every((p) => p.type === "text");
        msgs.push({
          role: "user",
          content: onlyText ? parts.map((p) => p.text).join("\n") : parts,
        });
      }
      continue;
    }
    msgs.push({ role: m.role === "assistant" ? "assistant" : "user", content: flattenContent(content) });
  }

  // === Prompted tool-calling fallback ===
  // Most cheap/free upstreams (gpt-chatbot.ru etc.) silently DROP the
  // native `tools` param. Claude Code depends on tool-use for Read/Bash/Edit,
  // so we inject a system prompt describing the tools and ask the model to
  // emit <tool_call>{...}</tool_call> blocks. We also rewrite prior
  // tool_use / tool_result messages into plain text so a model that never
  // saw the tool schema can still follow the conversation.
  const promptedTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (promptedTools) {
    // Rewrite assistant tool_calls -> assistant text describing the call.
    // Rewrite role:"tool" replies -> user text with the tool result.
    const rewritten: any[] = [];
    for (const mm of msgs) {
      if (mm.role === "assistant" && Array.isArray(mm.tool_calls) && mm.tool_calls.length) {
        const parts: string[] = [];
        if (mm.content) parts.push(String(mm.content));
        for (const tc of mm.tool_calls) {
          parts.push(`<tool_call>${JSON.stringify({ id: tc.id, name: tc.function?.name, arguments: safeParse(tc.function?.arguments) })}</tool_call>`);
        }
        rewritten.push({ role: "assistant", content: parts.join("\n") });
      } else if (mm.role === "tool") {
        rewritten.push({
          role: "user",
          content: `<tool_result tool_call_id="${mm.tool_call_id ?? ""}">\n${typeof mm.content === "string" ? mm.content : JSON.stringify(mm.content)}\n</tool_result>`,
        });
      } else {
        rewritten.push(mm);
      }
    }
    const toolDocs = body.tools.map((t: any) => {
      const name = t.name;
      const desc = t.description ?? "";
      const schema = t.input_schema ?? t.parameters ?? { type: "object", properties: {} };
      return `- ${name}: ${desc}\n  input JSON schema: ${JSON.stringify(schema)}`;
    }).join("\n");
    const forced = body.tool_choice && body.tool_choice.type === "tool" ? body.tool_choice.name : null;
    const anyRequired = body.tool_choice && body.tool_choice.type === "any";
    const toolInstr = [
      "# Tool Use Protocol",
      "You have access to the following tools. To invoke a tool, output ONE OR MORE tool call blocks EXACTLY in this format:",
      `<tool_call>{"name":"<tool_name>","arguments":{ ...json args... }}</tool_call>`,
      "Rules:",
      "- Use ONLY tools listed below. Arguments MUST be valid JSON matching the input schema.",
      "- Emit multiple <tool_call> blocks in the same response when parallel calls are useful.",
      "- Do NOT wrap tool_call blocks in code fences.",
      "- Do NOT explain that you 'cannot' use tools — you CAN, by emitting the block above.",
      "- Once no more tool calls are needed, respond in plain text.",
      forced ? `- You MUST call tool "${forced}" now.` : (anyRequired ? "- You MUST call at least one tool now." : ""),
      "",
      "## Available Tools",
      toolDocs,
    ].filter(Boolean).join("\n");
    // === CRITICAL: many cheap upstreams (gpt-chatbot.ru confirmed) DROP the
    // system role entirely. Fold system + tool instructions into the FIRST
    // user message so the model actually sees them. ===
    let sysContent = "";
    if (rewritten[0]?.role === "system") {
      sysContent = String(rewritten[0].content ?? "");
      rewritten.shift();
    }
    const combinedPreamble = [sysContent, toolInstr].filter(Boolean).join("\n\n");
    const firstUserIdx = rewritten.findIndex((r) => r.role === "user");
    if (firstUserIdx >= 0) {
      const u = rewritten[firstUserIdx];
      const uc = typeof u.content === "string"
        ? `${combinedPreamble}\n\n---\n\nUser: ${u.content}`
        : u.content; // multimodal parts — leave as-is, but prepend a text part
      if (typeof uc === "string") {
        rewritten[firstUserIdx] = { ...u, content: uc };
      } else if (Array.isArray(uc)) {
        rewritten[firstUserIdx] = { ...u, content: [{ type: "text", text: combinedPreamble + "\n\n---\n\nUser message:" }, ...uc] };
      }
    } else {
      rewritten.push({ role: "user", content: combinedPreamble });
    }
    const out: any = { model: body.model, messages: rewritten, stream: !!body.stream, _promptedTools: true };
    if (body.max_tokens != null) out.max_tokens = body.max_tokens;
    if (body.temperature != null) out.temperature = body.temperature;
    if (body.top_p != null) out.top_p = body.top_p;
    if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
    // Keep the native OpenAI-compatible tool schema as well as the prompt
    // fallback. Capable models such as GLM use native tool calls; providers
    // that ignore `tools` can still follow the textual protocol above.
    out.tools = body.tools
      .filter((t: any) => t && t.name && (t.input_schema || t.parameters))
      .map((t: any) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: t.input_schema ?? t.parameters ?? { type: "object", properties: {} },
        },
      }));
    if (body.tool_choice) {
      const tc = body.tool_choice;
      if (tc.type === "auto") out.tool_choice = "auto";
      else if (tc.type === "any") out.tool_choice = "required";
      else if (tc.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } };
      else if (tc.type === "none") out.tool_choice = "none";
    }
    return out;
  }

  const out: any = { model: body.model, messages: msgs, stream: !!body.stream };
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((t: any) => t && t.name && (t.input_schema || t.parameters))
      .map((t: any) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: t.input_schema ?? t.parameters ?? { type: "object", properties: {} },
        },
      }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === "auto") out.tool_choice = "auto";
    else if (tc.type === "any") out.tool_choice = "required";
    else if (tc.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } };
    else if (tc.type === "none") out.tool_choice = "none";
  }
  return out;
}

function safeParse(s: any) { try { return JSON.parse(s); } catch { return s ?? {}; } }

// Extract <tool_call>{...}</tool_call> blocks from a free-form assistant text.
// Returns cleaned text (blocks removed) and parsed tool_use blocks.
export function extractPromptedToolCalls(text: string): { cleanText: string; toolUses: Array<{ id: string; name: string; input: any }> } {
  const toolUses: Array<{ id: string; name: string; input: any }> = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let cleanText = text.replace(re, (_m, inner) => {
    let obj: any = null;
    try { obj = JSON.parse(inner); } catch {
      // try to salvage: sometimes model wraps in ```json ... ```
      const stripped = inner.replace(/^```json\s*|\s*```$/g, "").trim();
      try { obj = JSON.parse(stripped); } catch { obj = null; }
    }
    if (obj && typeof obj === "object" && obj.name) {
      const id = obj.id || ("toolu_" + Math.random().toString(36).slice(2, 12));
      toolUses.push({ id, name: String(obj.name), input: obj.arguments ?? obj.input ?? {} });
    }
    return "";
  }).trim();
  return { cleanText, toolUses };
}

export function openaiToAnth(oai: any, modelName: string) {
  const choice = oai?.choices?.[0];
  const msg = choice?.message ?? {};
  const finish = choice?.finish_reason;
  const contentBlocks: any[] = [];
  const text = typeof msg.content === "string" ? msg.content : flattenContent(msg.content);
  if (text) contentBlocks.push({ type: "text", text });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input: any = {};
      try { input = JSON.parse(tc?.function?.arguments ?? "{}"); } catch { input = { _raw: tc?.function?.arguments }; }
      contentBlocks.push({
        type: "tool_use",
        id: tc.id ?? "toolu_" + Math.random().toString(36).slice(2),
        name: tc?.function?.name ?? "tool",
        input,
      });
    }
  }
  const stop_reason =
    finish === "stop" ? "end_turn" :
    finish === "length" ? "max_tokens" :
    finish === "tool_calls" ? "tool_use" :
    finish ?? "end_turn";
  return {
    id: oai?.id ?? "msg_" + Math.random().toString(36).slice(2),
    type: "message",
    role: "assistant",
    model: modelName,
    content: contentBlocks.length ? contentBlocks : [{ type: "text", text: "" }],
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: oai?.usage?.prompt_tokens ?? 0,
      output_tokens: oai?.usage?.completion_tokens ?? 0,
    },
  };
}

export function translateStream(upstream: ReadableStream<Uint8Array>, modelName: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const msgId = "msg_" + Math.random().toString(36).slice(2);
  let started = false;
  let textBlockIdx: number | null = null;
  let nextIdx = 0;
  const toolBlocks = new Map<number, { id: string; name: string; anthIdx: number; argBuf: string }>();
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = "end_turn";
  const nativeToolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let buf = "";

  const sse = (event: string, data: any) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let finished = false;
      const heartbeat = setInterval(() => {
        if (!finished) controller.enqueue(sse("ping", { type: "ping" }));
      }, 15_000);
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const l = line.trim();
            if (!l.startsWith("data:")) continue;
            const payload = l.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let j: any;
            try { j = JSON.parse(payload); } catch { continue; }
            if (!started) {
              started = true;
              inputTokens = j?.usage?.prompt_tokens ?? 0;
              controller.enqueue(sse("message_start", {
                type: "message_start",
                message: {
                  id: msgId, type: "message", role: "assistant", model: modelName,
                  content: [], stop_reason: null, stop_sequence: null,
                  usage: { input_tokens: inputTokens, output_tokens: 0 },
                },
              }));
              controller.enqueue(sse("ping", { type: "ping" }));
            }
            const ch = j?.choices?.[0];
            const delta = ch?.delta;
            // GLM/DeepSeek-compatible providers may expose reasoning separately.
            // Preserve it in the Anthropic text stream instead of dropping it.
            const textDelta = delta?.content ?? delta?.reasoning_content;
            if (textDelta) {
              if (textBlockIdx === null) {
                textBlockIdx = nextIdx++;
                controller.enqueue(sse("content_block_start", {
                  type: "content_block_start", index: textBlockIdx,
                  content_block: { type: "text", text: "" },
                }));
              }
              controller.enqueue(sse("content_block_delta", {
                type: "content_block_delta", index: textBlockIdx,
                delta: { type: "text_delta", text: typeof textDelta === "string" ? textDelta : flattenContent(textDelta) },
              }));
            }
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                let block = toolBlocks.get(idx);
                if (!block) {
                  const id = tc.id ?? "toolu_" + Math.random().toString(36).slice(2);
                  const name = tc?.function?.name ?? "tool";
                  const anthIdx = nextIdx++;
                  block = { id, name, anthIdx, argBuf: "" };
                  toolBlocks.set(idx, block);
                  controller.enqueue(sse("content_block_start", {
                    type: "content_block_start", index: anthIdx,
                    content_block: { type: "tool_use", id, name, input: {} },
                  }));
                } else if (tc?.function?.name && block.name === "tool") {
                  block.name = tc.function.name;
                }
                const argChunk = tc?.function?.arguments;
                if (argChunk) {
                  block.argBuf += argChunk;
                  controller.enqueue(sse("content_block_delta", {
                    type: "content_block_delta", index: block.anthIdx,
                    delta: { type: "input_json_delta", partial_json: argChunk },
                  }));
                }
              }
            }
            if (ch?.finish_reason) {
              stopReason = ch.finish_reason === "length" ? "max_tokens" : ch.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
            }
            if (j?.usage?.completion_tokens != null) outputTokens = j.usage.completion_tokens;
          }
        }
        if (textBlockIdx !== null) controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: textBlockIdx }));
        for (const tb of toolBlocks.values()) controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: tb.anthIdx }));
        controller.enqueue(sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } }));
        controller.enqueue(sse("message_stop", { type: "message_stop" }));
        controller.close();
      } catch {
        // A body reset must still end with a valid Anthropic stream. Propagating
        // a ReadableStream error leaves SDKs with a network exception and no
        // response object, which is the source of `reading 'response'` crashes.
        try {
          if (!started) {
            started = true;
            controller.enqueue(sse("message_start", {
              type: "message_start",
              message: {
                id: msgId, type: "message", role: "assistant", model: modelName,
                content: [], stop_reason: null, stop_sequence: null,
                usage: { input_tokens: inputTokens, output_tokens: 0 },
              },
            }));
          }
          if (textBlockIdx !== null) controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: textBlockIdx }));
          for (const tb of toolBlocks.values()) controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: tb.anthIdx }));
          controller.enqueue(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } }));
          controller.enqueue(sse("message_stop", { type: "message_stop" }));
          controller.close();
        } catch {}
      } finally {
        finished = true;
        clearInterval(heartbeat);
      }
    },
    cancel(r) { void reader.cancel(r); },
  });
}

function mapErrType(status: number) {
  if (status === 401) return "authentication_error";
  if (status === 402) return "billing_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

/**
 * Streaming translator for the *prompted tools* path.
 *
 * Previously this path forced `stream: false` upstream so the full text could
 * be scanned for <tool_call> blocks. Agentic Claude Code turns routinely run
 * longer than the upstream edge proxy's ~125s buffered-response limit, which
 * returned `error code: 524` on every long request. We now stream upstream and
 * scan incrementally: plain text is forwarded live (holding back only a short
 * tail that could be a partial "<tool_call>" marker) and complete tool_call
 * blocks are emitted as real Anthropic tool_use blocks.
 */
const TOOL_OPEN = "<tool_call>";
const TOOL_CLOSE = "</tool_call>";

export function translatePromptedStream(upstream: ReadableStream<Uint8Array>, modelName: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const msgId = "msg_" + Math.random().toString(36).slice(2);
  const reader = upstream.getReader();

  let closed = false;
  let sseBuf = "";
  let textBuf = "";
  let nextIdx = 0;
  let textIdx: number | null = null;
  let sawTool = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = "end_turn";
  const nativeToolCalls = new Map<number, { id: string; name: string; arguments: string }>();


  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: any) => {
        if (closed) return;
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // Emit immediately so bytes flow from t=0 — this is what keeps proxies
      // from timing the request out while the model is still thinking.
      send("message_start", {
        type: "message_start",
        message: {
          id: msgId, type: "message", role: "assistant", model: modelName,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      send("ping", { type: "ping" });

      // Heartbeat: some upstreams go quiet for minutes between tokens.
      const heartbeat = setInterval(() => send("ping", { type: "ping" }), 15_000);

      const openText = () => {
        if (textIdx === null) {
          textIdx = nextIdx++;
          send("content_block_start", { type: "content_block_start", index: textIdx, content_block: { type: "text", text: "" } });
        }
      };
      const emitText = (chunk: string) => {
        if (!chunk) return;
        openText();
        send("content_block_delta", { type: "content_block_delta", index: textIdx, delta: { type: "text_delta", text: chunk } });
      };
      const closeText = () => {
        if (textIdx !== null) {
          send("content_block_stop", { type: "content_block_stop", index: textIdx });
          textIdx = null;
        }
      };
      const emitToolUse = (raw: string) => {
        let parsed: any = null;
        try { parsed = JSON.parse(raw.trim()); } catch { return; }
        const name = parsed?.name ?? parsed?.tool ?? parsed?.function;
        if (!name) return;
        const input = parsed?.arguments ?? parsed?.input ?? parsed?.parameters ?? {};
        const id = parsed?.id ?? "toolu_" + Math.random().toString(36).slice(2);
        closeText();
        sawTool = true;
        const idx = nextIdx++;
        send("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "tool_use", id, name, input: {} } });
        send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(input ?? {}) } });
        send("content_block_stop", { type: "content_block_stop", index: idx });
      };

      // Drain textBuf: forward safe text, emit any complete tool_call blocks.
      const drain = (final: boolean) => {
        for (;;) {
          const open = textBuf.indexOf(TOOL_OPEN);
          if (open === -1) break;
          const close = textBuf.indexOf(TOOL_CLOSE, open + TOOL_OPEN.length);
          if (close === -1) {
            emitText(textBuf.slice(0, open));
            textBuf = textBuf.slice(open);
            if (final) { emitText(textBuf); textBuf = ""; }
            return;
          }
          emitText(textBuf.slice(0, open));
          emitToolUse(textBuf.slice(open + TOOL_OPEN.length, close));
          textBuf = textBuf.slice(close + TOOL_CLOSE.length);
        }
        if (final) { emitText(textBuf); textBuf = ""; return; }
        // Hold back a tail that could be the start of "<tool_call>".
        let hold = 0;
        for (let n = Math.min(TOOL_OPEN.length - 1, textBuf.length); n > 0; n--) {
          if (textBuf.endsWith(TOOL_OPEN.slice(0, n))) { hold = n; break; }
        }
        const safe = textBuf.slice(0, textBuf.length - hold);
        textBuf = textBuf.slice(textBuf.length - hold);
        emitText(safe);
      };

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          sseBuf += dec.decode(value, { stream: true });
          const lines = sseBuf.split("\n");
          sseBuf = lines.pop() ?? "";
          for (const line of lines) {
            const l = line.trim();
            if (!l.startsWith("data:")) continue;
            const payload = l.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let j: any;
            try { j = JSON.parse(payload); } catch { continue; }
            if (j?.usage?.prompt_tokens != null) inputTokens = j.usage.prompt_tokens;
            if (j?.usage?.completion_tokens != null) outputTokens = j.usage.completion_tokens;
            const ch = j?.choices?.[0];
            const d = ch?.delta?.content ?? ch?.delta?.reasoning_content;
            if (d) textBuf += typeof d === "string" ? d : flattenContent(d);
            // Native tool-call arguments arrive over multiple SSE chunks. Keep
            // the complete call and emit it only after valid JSON is assembled.
            if (Array.isArray(ch?.delta?.tool_calls)) {
              for (const tc of ch.delta.tool_calls) {
                const idx = tc.index ?? 0;
                const call = nativeToolCalls.get(idx) ?? {
                  id: tc.id ?? "toolu_" + Math.random().toString(36).slice(2),
                  name: "",
                  arguments: "",
                };
                if (tc.id) call.id = tc.id;
                if (tc?.function?.name) call.name = tc.function.name;
                if (tc?.function?.arguments) call.arguments += tc.function.arguments;
                nativeToolCalls.set(idx, call);
              }
            }
            if (ch?.finish_reason === "length") stopReason = "max_tokens";
            drain(false);
          }
        }
        drain(true);
        for (const call of nativeToolCalls.values()) {
          if (!call.name) continue;
          let args: any = {};
          try { args = JSON.parse(call.arguments || "{}"); }
          catch { args = { _raw: call.arguments }; }
          emitToolUse(JSON.stringify({ id: call.id, name: call.name, arguments: args }));
        }
      } catch {
        drain(true);
      } finally {
        clearInterval(heartbeat);
        closeText();
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: sawTool ? "tool_use" : stopReason, stop_sequence: null },
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        });
        send("message_stop", { type: "message_stop" });
        closed = true;
        try { controller.close(); } catch {}
      }
    },
    cancel(r) { closed = true; try { reader.cancel(r); } catch {} },
  });
}

/** Aggregate an upstream OpenAI SSE stream into one non-streaming response. */
export async function collectOpenAIStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let finish: string | null = null;
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  const toolCalls: any[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;
      const payload = l.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let j: any;
      try { j = JSON.parse(payload); } catch { continue; }
      if (j?.usage?.prompt_tokens != null) usage.prompt_tokens = j.usage.prompt_tokens;
      if (j?.usage?.completion_tokens != null) usage.completion_tokens = j.usage.completion_tokens;
      const ch = j?.choices?.[0];
      const d = ch?.delta?.content;
      if (d) text += typeof d === "string" ? d : flattenContent(d);
      if (Array.isArray(ch?.delta?.tool_calls)) {
        for (const tc of ch.delta.tool_calls) {
          const i = tc.index ?? 0;
          toolCalls[i] = toolCalls[i] ?? { id: tc.id, type: "function", function: { name: "", arguments: "" } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc?.function?.name) toolCalls[i].function.name = tc.function.name;
          if (tc?.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
      if (ch?.finish_reason) finish = ch.finish_reason;
    }
  }
  return {
    id: "chatcmpl_" + Math.random().toString(36).slice(2),
    choices: [{ message: { role: "assistant", content: text, ...(toolCalls.filter(Boolean).length ? { tool_calls: toolCalls.filter(Boolean) } : {}) }, finish_reason: finish ?? "stop" }],
    usage,
  };
}

export async function handleMessages(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object")
    return jsonResp({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON" } }, 400);
  const modelName = String(body.model ?? "");
  const openaiBody = anthToOpenAI(body);
  const prompted = !!openaiBody._promptedTools;
  const wantStream = !!body.stream;
  if (prompted) {
    // ALWAYS stream upstream on the prompted path. Buffered upstream calls on
    // long agentic turns get killed at ~125s by the provider's edge proxy
    // (`error code: 524`); streaming keeps bytes flowing so they complete.
    delete openaiBody._promptedTools;
    openaiBody.stream = true;
  } else {
    // Always stream upstream, even when Claude Code asks for a buffered JSON
    // response. This avoids the platform's first-byte deadline; we aggregate
    // back to JSON below for the caller.
    openaiBody.stream = true;
  }

  const { runGateway } = await import("@/lib/gateway-core.server");
  const started = Date.now();
  const r = await runGateway(request, openaiBody);

  if (r.kind === "error") {
    return jsonResp({ type: "error", error: { type: mapErrType(r.status), message: r.body?.error?.message ?? "error" } }, r.status);
  }
  if (r.kind === "upstream_error") {
    return jsonResp({ type: "error", error: { type: mapErrType(r.status), message: r.body.slice(0, 500) } }, r.status);
  }

  const sseHeaders = () => ({
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-silence-latency-ms": String(Date.now() - started),
    ...cors(),
  });

  if (r.kind === "stream") {
    if (prompted) {
      if (wantStream) {
        return new Response(translatePromptedStream(r.body, modelName), { status: 200, headers: sseHeaders() });
      }
      // Client wants JSON but we streamed upstream — aggregate, then convert.
      const oaiAgg = await collectOpenAIStream(r.body);
      return new Response(JSON.stringify(promptedToAnth(oaiAgg, modelName)), {
        status: 200,
        headers: { "content-type": "application/json", "x-silence-latency-ms": String(Date.now() - started), ...cors() },
      });
    }
    if (!wantStream) {
      const oaiAgg = await collectOpenAIStream(r.body);
      return new Response(JSON.stringify(openaiToAnth(oaiAgg, modelName)), {
        status: 200,
        headers: { "content-type": "application/json", "x-silence-latency-ms": String(Date.now() - started), ...cors() },
      });
    }
    return new Response(translateStream(r.body, modelName), { status: 200, headers: sseHeaders() });
  }

  // Upstream ignored `stream` and returned a buffered JSON body.
  let oai: any = {};
  try { oai = JSON.parse(r.text); } catch {}
  const anth = prompted ? promptedToAnth(oai, modelName) : openaiToAnth(oai, modelName);

  if (prompted && wantStream) {
    return new Response(syntheticAnthStream(anth), { status: 200, headers: sseHeaders() });
  }
  return new Response(JSON.stringify(anth), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-silence-latency-ms": String(Date.now() - started),
      ...cors(),
    },
  });
}

/** Convert an OpenAI response whose tool calls may be prompted <tool_call> text. */
function promptedToAnth(oai: any, modelName: string) {
  const anth = openaiToAnth(oai, modelName);
  const textBlock = anth.content.find((b: any) => b.type === "text");
  const raw = textBlock?.text ?? "";
  const { cleanText, toolUses } = extractPromptedToolCalls(raw);
  const blocks: any[] = [];
  if (cleanText) blocks.push({ type: "text", text: cleanText });
  for (const b of anth.content) if (b.type === "tool_use") blocks.push(b);
  for (const tu of toolUses) blocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
  const hasTool = blocks.some((b) => b.type === "tool_use");
  return {
    ...anth,
    content: blocks.length ? blocks : [{ type: "text", text: "" }],
    stop_reason: hasTool ? "tool_use" : (anth.stop_reason ?? "end_turn"),
  };
}

function syntheticAnthStream(anth: any): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const sse = (event: string, data: any) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sse("message_start", {
        type: "message_start",
        message: {
          id: anth.id, type: "message", role: "assistant", model: anth.model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: anth.usage?.input_tokens ?? 0, output_tokens: 0 },
        },
      }));
      controller.enqueue(sse("ping", { type: "ping" }));
      anth.content.forEach((block: any, idx: number) => {
        if (block.type === "text") {
          controller.enqueue(sse("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } }));
          if (block.text) controller.enqueue(sse("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: block.text } }));
          controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: idx }));
        } else if (block.type === "tool_use") {
          controller.enqueue(sse("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }));
          controller.enqueue(sse("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } }));
          controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: idx }));
        }
      });
      controller.enqueue(sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: anth.stop_reason ?? "end_turn", stop_sequence: null },
        usage: { output_tokens: anth.usage?.output_tokens ?? 0 },
      }));
      controller.enqueue(sse("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });
}

export async function handleCountTokens(request: Request): Promise<Response> {
  // Token counting was previously unauthenticated — any anonymous caller could
  // burn gateway compute and probe the endpoint. Require a valid Silence key.
  const { authenticateGatewayKey } = await import("@/lib/gateway-auth.server");
  const auth = await authenticateGatewayKey(request, "count_tokens");
  if (!auth.ok) {
    return jsonResp({ type: "error", error: { type: mapErrType(auth.status), message: auth.message } }, auth.status);
  }
  const body = await request.json().catch(() => null);
  if (!body) return jsonResp({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON" } }, 400);
  const sys = body.system ? (typeof body.system === "string" ? body.system : flattenContent(body.system)) : "";
  let chars = sys.length;
  for (const m of body.messages ?? []) chars += flattenContent(m.content).length;
  const input_tokens = Math.max(1, Math.ceil(chars / 4));
  return jsonResp({ input_tokens });
}
