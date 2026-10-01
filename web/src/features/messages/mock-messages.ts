import type { DirectMessage } from "./nip17";

const now = Math.floor(Date.now() / 1000);
const hex = (c: string) => c.repeat(64);

/** Dev-preview conversations (`?preview=feed`) — no relay or signer involved. */
export function mockMessages(viewer: string): DirectMessage[] {
  const m = (
    n: string,
    from: string,
    peer: string,
    ago: number,
    content: string,
  ): DirectMessage => ({
    id: n.repeat(64).slice(0, 64),
    wrapId: n.repeat(64).slice(0, 64),
    from,
    peer,
    content,
    at: now - ago,
  });
  return [
    m("d1", hex("b"), hex("b"), 3600, "Hey! Did you see the relay build?"),
    m("d2", viewer, hex("b"), 3500, "Yes — latency looks great."),
    m("d3", hex("b"), hex("b"), 120, "Want to demo it on Friday?"),
    m("d4", hex("c"), hex("c"), 86400 * 2, "Thanks for the review 🙏"),
  ];
}
