/**
 * Which peers in a live room have proved they are community members.
 *
 * A peer is verified once it has sent one envelope that passed the whole
 * accept path (the relay + `live-members.ts`), and stops being verified when it leaves. Only
 * verified peers are sent page content: a room is joinable by strangers, so
 * "everyone in the room" must never be the audience of a broadcast.
 *
 * Deliberately free of `@/` imports so `node --test` can exercise it.
 */
export class PeerBook {
  private readonly verified = new Map<string, string>();

  /** Record a verified peer; true when it was not verified before. */
  markVerified(peerId: string, signer: string): boolean {
    const isNew = !this.verified.has(peerId);
    this.verified.set(peerId, signer);
    return isNew;
  }

  leave(peerId: string): void {
    this.verified.delete(peerId);
  }

  isVerified(peerId: string): boolean {
    return this.verified.has(peerId);
  }

  /** Transport ids that may be sent page content. */
  verifiedPeerIds(): string[] {
    return [...this.verified.keys()];
  }

  get verifiedCount(): number {
    return this.verified.size;
  }
}
