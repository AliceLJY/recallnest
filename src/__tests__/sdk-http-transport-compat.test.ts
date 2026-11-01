/**
 * @hono/node-server 是 MCP SDK 的 StreamableHTTPServerTransport 唯一的使用者（RecallNest 自己的 src/ 不 import 它，
 * package.json 里的直接依赖只为钉住安全版本）。跨大版本升级之后，这里在 Bun 下用 node:http 真起一个
 * Streamable HTTP MCP 端点，发 initialize 与 tools/list，确认 SDK 经 getRequestListener 走 Node ↔ Web 标准
 * 转换这条路仍然通。只监听 127.0.0.1 的随机端口。
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

let httpServer: Server;
let baseUrl = "";

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    // Stateless mode: a fresh server + transport per request, as the SDK docs recommend.
    const mcp = new McpServer({ name: "compat", version: "0" });
    mcp.tool("echo", "Echo text back", { text: z.string() }, async ({ text }) => ({
      content: [{ type: "text", text }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    void mcp.connect(transport).then(() => transport.handleRequest(req, res));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

async function rpc(method: string, params: Record<string, unknown>, id: number): Promise<{ status: number; body: unknown }> {
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: res.status, body: await res.json() };
}

describe("MCP SDK Streamable HTTP transport over @hono/node-server", () => {
  it("answers initialize", async () => {
    const { status, body } = await rpc(
      "initialize",
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      1,
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "compat" } } });
  });

  it("answers tools/call with the request body parsed", async () => {
    const { status, body } = await rpc("tools/call", { name: "echo", arguments: { text: "你好 hono" } }, 2);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: 2, result: { content: [{ type: "text", text: "你好 hono" }] } });
  });
});
