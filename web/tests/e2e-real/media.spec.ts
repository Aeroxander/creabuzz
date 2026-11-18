import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

import type { Browser, Page } from "@playwright/test";

import { expect, test } from "./frame-meter";
import { finalizeEvent } from "nostr-tools/pure";

import { keyFromHex, PEOPLE, post } from "./social-helpers.mjs";

/**
 * Pictures on a REAL server (`scripts/web-social-e2e.sh`): the server hands a stored picture only to a signed read, so
 * a plain `<img src>` of it never loads. Alice adds a picture to a board post with the composer's "Add a picture"; Bob,
 * another member, opens the board and sees it — the list thumbnail and the picture in the post both load (naturalWidth
 * > 0) from an object URL the app fetched with a signed read. Nothing is mocked.
 *
 * Needs the server's media store working (the dev MinIO on localhost:9000 with the `buzz-media` bucket, which
 * `just setup` starts) and the server handing out addresses on itself
 * (`BUZZ_MEDIA_BASE_URL=http://localhost:3199/media`; the relay's default points at :3000). Without either it skips,
 * saying which.
 */

test.use({ viewport: { width: 1280, height: 900 } });

const HOST = "localhost:3199";
const ORIGIN = `http://${HOST}`;
const RUN = Date.now().toString(36);

/** CRC-32 as PNG chunks use it. */
function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A plain-colour PNG with no metadata chunks (the server refuses those). A colour per run keeps each upload new. */
function solidPng(width: number, height: number, rgb: number[]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: width }, () => rgb).flat()),
  ]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function runColour(salt: number): number[] {
  const seed = Number.parseInt(RUN.slice(-6), 36) + salt;
  return [seed & 0xff, (seed >> 8) & 0xff, (seed >> 16) & 0xff];
}

/**
 * Whether this server can store a picture and hands out addresses on itself: one upload as Alice, the same request
 * the web app makes. Returns why not, or null.
 */
async function uploadsUnavailable(): Promise<string | null> {
  const bytes = solidPng(4, 4, runColour(7));
  const sha256 = Buffer.from(
    await crypto.subtle.digest("SHA-256", bytes),
  ).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  const auth = finalizeEvent(
    {
      kind: 24242,
      created_at: now,
      tags: [
        ["t", "upload"],
        ["expiration", String(now + 60)],
        ["server", HOST],
        ["x", sha256],
      ],
      content: "media spec probe",
    },
    keyFromHex(PEOPLE.alice),
  );
  let response: Response;
  try {
    response = await fetch(`${ORIGIN}/upload`, {
      method: "PUT",
      headers: {
        Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`,
        "X-SHA-256": sha256,
        "Content-Type": "image/png",
      },
      body: bytes,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return `the upload did not answer (${String(error)}): is the dev MinIO on localhost:9000 running?`;
  }
  if (!response.ok) {
    return `the upload was refused (${response.status} ${await response.text()}): is the dev MinIO on localhost:9000 running with the buzz-media bucket?`;
  }
  const { url } = (await response.json()) as { url: string };
  if (!url.startsWith(`${ORIGIN}/media/`)) {
    return `the server hands out picture addresses on ${url} instead of ${ORIGIN}/media: start it with BUZZ_MEDIA_BASE_URL=${ORIGIN}/media`;
  }
  // The premise this spec exists for: without a signed read the picture is not handed over.
  const unsigned = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (unsigned.ok) {
    throw new Error(
      `${url} was served without a signed read; this spec no longer tests what it says`,
    );
  }
  return null;
}

async function signedIn(
  browser: Browser,
  who: keyof typeof PEOPLE,
): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, PEOPLE[who]);
  return page;
}

/** Wait until `selector`'s first match is an `<img>` that decoded (naturalWidth > 0), and say where it loaded from. */
async function loadedPicture(page: Page, selector: string): Promise<string> {
  const picture = page.locator(`img${selector}`).first();
  await expect(picture).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      () =>
        picture.evaluate(
          (element) =>
            (element as HTMLImageElement).complete &&
            (element as HTMLImageElement).naturalWidth,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  return (await picture.getAttribute("src")) ?? "";
}

test("a picture one member adds to a board post shows for another member", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const why = await uploadsUnavailable();
  test.skip(why !== null, `Pictures can't be uploaded here: ${why}`);

  const board = randomUUID();
  const title = `A picture ${RUN}`;
  await post("alice", {
    kind: 9007,
    tags: [
      ["h", board],
      ["name", `pictures-${RUN}`],
      ["visibility", "open"],
      ["channel_type", "forum"],
    ],
    content: "",
  });

  const alice = await signedIn(browser, "alice");
  await test.step("Alice adds a picture to a new post with the composer", async () => {
    await alice.goto(`/c/${HOST}?channel=${board}`);
    await alice.getByTestId("board-new-post").click({ timeout: 60_000 });
    await alice.getByPlaceholder("Title").fill(title);
    await alice.getByTestId("board-composer-file").setInputFiles({
      name: "picture.png",
      mimeType: "image/png",
      buffer: solidPng(24, 16, runColour(1)),
    });
    await expect(alice.locator("#board-post-body")).toHaveValue(
      new RegExp(`!\\[\\]\\(${ORIGIN}/media/[0-9a-f]{64}\\.png\\)`),
      { timeout: 30_000 },
    );
    await expect(alice.getByTestId("board-composer-problem")).toHaveCount(0);
    await alice.getByTestId("board-composer-submit").click();
    await expect(
      alice.getByTestId("board-post-title").filter({ hasText: title }),
    ).toBeVisible({ timeout: 30_000 });
  });

  const bob = await signedIn(browser, "bob");
  await test.step("Bob opens the board and sees the picture in the list", async () => {
    await bob.goto(`/c/${HOST}?channel=${board}`);
    await expect(
      bob.getByTestId("board-post-title").filter({ hasText: title }),
    ).toBeVisible({ timeout: 60_000 });
    const src = await loadedPicture(
      bob,
      '[data-testid="board-post-thumbnail"]',
    );
    // Loaded through the signed read, not straight from the address (which the server refuses).
    expect(src).toMatch(/^blob:/);
    await expect(
      bob.getByTestId("board-post-thumbnail-unavailable"),
    ).toHaveCount(0);
  });

  await test.step("and in the post itself", async () => {
    await bob
      .getByTestId("board-post-title")
      .filter({ hasText: title })
      .click();
    await expect(bob.getByTestId("board-thread-title")).toContainText(title, {
      timeout: 30_000,
    });
    const src = await loadedPicture(
      bob,
      '[data-testid="board-markdown-picture"]',
    );
    expect(src).toMatch(/^blob:/);
  });
});
