/**
 * OpenCompress Local Proxy — receives requests from OpenClaw,
 * compresses via OpenCompress API, forwards to user's upstream provider.
 *
 * Runs on localhost:8401. All upstream keys stay local — only sent
 * per-request as headers to opencompress.ai, never stored server-side.
 */

import http from "http";
import { VERSION, PROXY_PORT, PROXY_HOST, OCC_API } from "./config.js";
import { resolveUpstream, type ProviderConfig } from "./models.js";

type GetProviders = () => Record<string, ProviderConfig>;
type GetOccKey = () => string | undefined;

let server: http.Server | null = null;

export function startProxy(getProviders: GetProviders, getOccKey: GetOccKey): http.Server {
  if (server) return server;

  server = http.createServer(async (req, res) => {
    // Health check
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: VERSION }));
      return;
    }

    // Provision endpoint — plugin calls this instead of fetch() directly
    if (req.url === "/provision" && req.method === "POST") {
      try {
        const provRes = await fetch(`${OCC_API}/v1/provision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "openclaw-plugin" }),
        });
        const data = await provRes.text();
        res.writeHead(provRes.status, { "Content-Type": "application/json" });
        res.end(data);
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      }
      return;
    }

    // Stats endpoint — plugin calls this instead of fetch() directly
    if (req.url === "/stats" && req.method === "GET") {
      const authHeader = req.headers["authorization"] || "";
      try {
        const statsRes = await fetch(`${OCC_API}/user/stats`, {
          headers: { Authorization: authHeader },
        });
        const data = await statsRes.text();
        res.writeHead(statsRes.status, { "Content-Type": "application/json" });
        res.end(data);
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      }
      return;
    }

    // Only handle POST /v1/chat/completions and /v1/messages
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("Method not allowed");
      return;
    }

    const isMessages = req.url === "/v1/messages";
    const isCompletions = req.url === "/v1/chat/completions";

    if (!isMessages && !isCompletions) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      const modelId = parsed.model || "opencompress/auto";

      // Resolve upstream provider from model ID
      const upstream = resolveUpstream(modelId, getProviders());
      if (!upstream) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: { message: `Cannot resolve upstream for model: ${modelId}. Check your provider config.` },
        }));
        return;
      }

      const occKey = getOccKey();
      if (!occKey) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: { message: "No OpenCompress API key. Run: openclaw onboard opencompress" },
        }));
        return;
      }

      // Choose OCC endpoint based on upstream API type
      const occEndpoint = upstream.upstreamApi === "anthropic-messages"
        ? `${OCC_API}/v1/messages`
        : `${OCC_API}/v1/chat/completions`;

      // Build headers
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-api-key": occKey,
      };

      if (upstream.upstreamKey) {
        headers["x-upstream-key"] = upstream.upstreamKey;
      }
      if (upstream.upstreamBaseUrl) {
        headers["x-upstream-base-url"] = upstream.upstreamBaseUrl;
      }
      if (upstream.upstreamApi === "anthropic-messages") {
        headers["anthropic-version"] = req.headers["anthropic-version"] as string || "2023-06-01";
      }

      // Forward all anthropic-* headers from original request
      for (const [key, val] of Object.entries(req.headers)) {
        if (key.startsWith("anthropic-") && typeof val === "string") {
          headers[key] = val;
        }
      }

      // Set the actual upstream model (strip our prefix)
      parsed.model = upstream.upstreamModel;

      // SSE heartbeat to prevent timeout
      const isStream = parsed.stream !== false;
      if (isStream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const heartbeat = setInterval(() => {
          try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
        }, 2000);

        try {
          const occRes = await fetch(occEndpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(parsed),
          });

          clearInterval(heartbeat);

          if (!occRes.ok) {
            // Fallback: try direct to upstream (no compression)
            const fallbackRes = await directUpstream(upstream, parsed, req.headers);
            if (fallbackRes) {
              for await (const chunk of fallbackRes.body as AsyncIterable<Uint8Array>) {
                res.write(chunk);
              }
            } else {
              res.write(`data: ${JSON.stringify({ error: { message: `OpenCompress error: ${occRes.status}` } })}\n\n`);
            }
            res.end();
            return;
          }

          // Read compression stats from response headers
          const origTokens = parseInt(occRes.headers.get("x-opencompress-original-tokens") || "0", 10);
          const compTokens = parseInt(occRes.headers.get("x-opencompress-compressed-tokens") || "0", 10);
          const tokensSaved = origTokens - compTokens;

          // Pipe SSE response
          for await (const chunk of occRes.body as AsyncIterable<Uint8Array>) {
            res.write(chunk);
          }

          // Append savings footer as a final text delta (if we actually saved tokens)
          if (tokensSaved > 0 && isMessages) {
            const savingsText = `\n\n---\n_Compressed by OpenCompress: ${tokensSaved} input tokens saved_`;
            const deltaEvent = {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: savingsText },
            };
            res.write(`event: content_block_delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`);
          }

          res.end();
        } catch (err) {
          clearInterval(heartbeat);
          // Fallback on network error
          try {
            const fallbackRes = await directUpstream(upstream, parsed, req.headers);
            if (fallbackRes) {
              for await (const chunk of fallbackRes.body as AsyncIterable<Uint8Array>) {
                res.write(chunk);
              }
            }
          } catch { /* double fault, give up */ }
          res.end();
        }
      } else {
        // Non-streaming
        try {
          const occRes = await fetch(occEndpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(parsed),
          });

          if (!occRes.ok) {
            const fallbackRes = await directUpstream(upstream, parsed, req.headers);
            const fallbackBody = fallbackRes ? await fallbackRes.text() : JSON.stringify({ error: { message: "Compression + direct both failed" } });
            res.writeHead(fallbackRes?.status || 502, { "Content-Type": "application/json" });
            res.end(fallbackBody);
            return;
          }

          const data = await occRes.text();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(data);
        } catch {
          const fallbackRes = await directUpstream(upstream, parsed, req.headers);
          const fallbackBody = fallbackRes ? await fallbackRes.text() : JSON.stringify({ error: { message: "Both paths failed" } });
          res.writeHead(fallbackRes?.status || 502, { "Content-Type": "application/json" });
          res.end(fallbackBody);
        }
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(err) } }));
    }
  });

  server.listen(PROXY_PORT, PROXY_HOST, () => {
    // Proxy started
  });

  // Handle port in use — previous proxy instance likely still running, just reuse it
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      server = null;
      // Port already taken — likely a previous gateway instance's proxy.
      // Don't force-kill; just skip and let the existing proxy serve requests.
    }
  });

  return server;
}

export function stopProxy() {
  if (server) {
    server.close();
    server = null;
  }
}

/** Fallback: send directly to upstream provider (no compression) */
async function directUpstream(
  upstream: { upstreamKey?: string; upstreamBaseUrl: string; upstreamModel: string; upstreamApi: string },
  body: Record<string, unknown>,
  originalHeaders: http.IncomingHttpHeaders,
): Promise<Response | null> {
  try {
    const url = upstream.upstreamApi === "anthropic-messages"
      ? `${upstream.upstreamBaseUrl}/v1/messages`
      : `${upstream.upstreamBaseUrl}/v1/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (upstream.upstreamApi === "anthropic-messages") {
      headers["x-api-key"] = upstream.upstreamKey || "";
      headers["anthropic-version"] = originalHeaders["anthropic-version"] as string || "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${upstream.upstreamKey || ""}`;
    }

    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
