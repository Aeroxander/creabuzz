import { createServer, type Server } from "node:http";

/**
 * A front for the stand-in that speaks as only one of the two services: a plain bundler (it knows no `zd_` method, as a
 * bundler that is not the sponsor would say) or the sponsor alone. Each counts what it was asked, so a request sent to the
 * wrong address is seen, not guessed.
 */
export async function startFront(
  target: string,
  serves: (method: string) => boolean,
  port = 0,
): Promise<{
  url: string;
  served: string[];
  refused: string[];
  close(): Promise<void>;
}> {
  const served: string[] = [];
  const refused: string[] = [];
  const server: Server = createServer((req, res) => {
    // A browser asks first (the page and this address are different origins), as it does of the real services.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, x-api-key");
    res.setHeader("access-control-allow-methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(text) as { id: number; method: string };
      res.setHeader("content-type", "application/json");
      if (!serves(body.method)) {
        refused.push(body.method);
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "Method not found" },
          }),
        );
        return;
      }
      served.push(body.method);
      const upstream = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: text,
      });
      res.end(await upstream.text());
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    served,
    refused,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
