import { expect, test } from "@playwright/test";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";

/**
 * Signing up with a passkey and signing in with it again, against a REAL server (outside review C 9): every other passkey
 * journey stubs the server (web-passkey-contributor-e2e) or the chain (web-passkey-wallet-e2e). Chrome's virtual
 * authenticator stands in for Touch ID, and the page is on `localhost`, where WebAuthn runs. Run by
 * `scripts/web-restricted-holder-e2e.sh`, whose server serves the pilot build (VITE_CONTRIBUTOR_ONLY=1, where the
 * passkey is the first way in).
 *
 * A person signs up with a passkey; the server keeps the name they typed under the passkey's key. A reload drops the key
 * from the page, so signing in again takes a fresh passkey assertion; then a post they write is accepted by the server
 * under the same key. Linking the name to a passkey account is not here: it needs the passkey account contracts and a
 * bundler on a chain this server's journeys do not have (web-passkey-contributor-e2e checks it on a Sepolia fork).
 */

const BASE = process.env.BUZZ_REAL_RELAY_URL ?? "";

test.skip(
  !BASE.startsWith("http://localhost:"),
  "needs a real server serving the web app on http://localhost:<port> (scripts/web-restricted-holder-e2e.sh)",
);

test.use({ viewport: { width: 1280, height: 900 } });

interface ServerEvent {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
}

/** Ask the server for events, as any client could: a socket of the test's own, signed in with a throwaway key. */
async function readEvents(filter: Record<string, unknown>) {
  const relay = BASE.replace(/^http/, "ws");
  const key = generateSecretKey();
  return new Promise<ServerEvent[]>((resolve, reject) => {
    const socket = new WebSocket(relay);
    const found: ServerEvent[] = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`no answer from ${relay}`));
    }, 15_000);
    socket.onmessage = (message) => {
      const frame = JSON.parse(String(message.data)) as unknown[];
      if (frame[0] === "AUTH") {
        socket.send(
          JSON.stringify([
            "AUTH",
            finalizeEvent(
              {
                kind: 22242,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                  ["relay", relay],
                  ["challenge", String(frame[1])],
                ],
                content: "",
              },
              key,
            ),
          ]),
        );
      } else if (frame[0] === "OK") {
        socket.send(JSON.stringify(["REQ", "read", filter]));
      } else if (frame[0] === "EVENT") {
        found.push(frame[2] as ServerEvent);
      } else if (frame[0] === "EOSE" || frame[0] === "CLOSED") {
        clearTimeout(timer);
        socket.close();
        resolve(found);
      }
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`could not reach ${relay}`));
    };
  });
}

test("a passkey account signs up, and signs in again after a reload, on a real server", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
        hasPrf: true,
      },
    },
  );
  const signCount = async () => {
    const { credentials } = (await cdp.send("WebAuthn.getCredentials", {
      authenticatorId,
    })) as { credentials: { signCount: number }[] };
    expect(credentials).toHaveLength(1);
    return credentials[0].signCount;
  };
  const name = `Passkey ${Date.now().toString(36)}`;

  await page.goto("/");
  await page.getByTestId("create-identity-cta").first().click();
  await page.getByTestId("onboarding-name").fill(name);
  await page.getByTestId("onboarding-passkey").click();
  await page.getByTestId("backup-close").click({ timeout: 30_000 });
  const pubkey = (await page.evaluate(() =>
    window.localStorage.getItem("buzz.passkey.pubkey"),
  )) as string;
  expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
  // Nothing secret is kept in the browser: the key lives in the passkey.
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("buzz.identity.nsec"),
    ),
  ).toBeNull();
  // The server holds the name under the passkey's key: the sign-up's write was signed and accepted.
  await expect
    .poll(
      async () =>
        (await readEvents({ kinds: [0], authors: [pubkey] })).map(
          (event) => (JSON.parse(event.content) as { name?: string }).name,
        ),
      { timeout: 30_000 },
    )
    .toContain(name);

  // Signing in again: the reload drops the key from the page, and the passkey is asked for it once more.
  const countBefore = await signCount();
  await page.goto("/social");
  await page.reload();
  const text = `Signed in again ${Date.now().toString(36)}`;
  await page.getByTestId("social-composer-input").fill(text);
  await page.getByTestId("social-composer-submit").click();
  await expect(
    page.getByTestId("social-post").filter({ hasText: text }),
  ).toBeVisible({ timeout: 60_000 });
  expect(
    await signCount(),
    "signing in again used the passkey",
  ).toBeGreaterThan(countBefore);
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("buzz.passkey.pubkey"),
    ),
  ).toBe(pubkey);
  await expect
    .poll(
      async () =>
        (await readEvents({ kinds: [1], authors: [pubkey] })).map(
          (event) => event.content,
        ),
      { timeout: 30_000 },
    )
    .toContain(text);
});
