// The two calls to the server: each is signed for that one request by the person's own key (the method, the address and the
// body), with the exact body the server reads, and a server that does not accept is an error that carries only its status.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spy = vi.hoisted(() => ({
  header: vi.fn(async (..._args: unknown[]) => "Nostr signed"),
  fetch: vi.fn(async (_url: string, _init: Record<string, unknown>) => ({
    ok: true,
    status: 200,
  })),
}));
vi.mock("@creaton/core/client/nip98.ts", () => ({
  makeNip98AuthHeader: spy.header,
}));
vi.mock("@creaton/core/client/relay-url.ts", () => ({
  relayHttpBaseUrl: () => "https://server.example",
}));
vi.mock("@creaton/core/client/timed-fetch.ts", () => ({
  timedFetchStreamed: spy.fetch,
}));

import { forgetDevice, PushCallError, saveDevice } from "./push-calls";

beforeEach(() => {
  spy.header.mockClear();
  spy.fetch.mockClear().mockResolvedValue({ ok: true, status: 200 });
});
afterEach(() => vi.restoreAllMocks());

const json = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  keys: { p256dh: "P", auth: "A", extra: "x" },
};

describe("saving a device", () => {
  it("is a PUT to /push/web signed over that method, address and the exact body, and sends only the three fields the server reads", async () => {
    await saveDevice(json);
    const [url, init] = spy.fetch.mock.calls[0];
    expect(url).toBe("https://server.example/push/web");
    expect(init.method).toBe("PUT");
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual({
      endpoint: json.endpoint,
      keys: { p256dh: "P", auth: "A" },
    });
    expect(spy.header).toHaveBeenCalledWith(
      "https://server.example/push/web",
      "PUT",
      { body },
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Nostr signed",
    );
  });

  it("sends nothing for a subscription that is missing a part", async () => {
    for (const bad of [
      {},
      { endpoint: json.endpoint },
      { endpoint: json.endpoint, keys: { p256dh: "P" } },
      { keys: json.keys },
    ])
      await expect(saveDevice(bad)).rejects.toThrow();
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("a server that does not accept is an error with its status and none of its words", async () => {
    spy.fetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const error = await saveDevice(json).catch((e) => e);
    expect(error).toBeInstanceOf(PushCallError);
    expect(error.status).toBe(404);
  });
});

describe("forgetting a device", () => {
  it("is a DELETE to /push/web signed over its body, which names only the address", async () => {
    await forgetDevice(json.endpoint);
    const [url, init] = spy.fetch.mock.calls[0];
    expect(url).toBe("https://server.example/push/web");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({
      endpoint: json.endpoint,
    });
    expect(spy.header).toHaveBeenCalledWith(
      "https://server.example/push/web",
      "DELETE",
      { body: init.body },
    );
  });

  it("is an error when the server does not accept", async () => {
    spy.fetch.mockResolvedValueOnce({ ok: false, status: 429 });
    await expect(forgetDevice(json.endpoint)).rejects.toBeInstanceOf(
      PushCallError,
    );
  });
});
