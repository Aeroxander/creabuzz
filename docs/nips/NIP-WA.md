NIP-WA
======

Workspace Access
----------------

`draft` `optional` `relay`

**Depends on**: NIP-01 (basic event format), NIP-11 (relay information document), NIP-42 (Authentication of Clients to Relays), NIP-43 (Relay Access Metadata and Requests), NIP-WP (Workspace Profile)

## Abstract

This NIP defines how a workspace says who may join it. A workspace is either **open** (anyone who can reach it may read and write, subject to channel membership) or **invite-only** (only members on its NIP-43 member list may). The workspace's owner switches between the two with a user-signed command (`kind:9034`); the relay stores the setting per workspace and serves it in its NIP-11 relay information document, where any client, member or not, reads it before trying to sign in.

## Motivation

NIP-43 lets a relay require membership, but as one setting for the whole relay. A relay that hosts many workspaces (one per community, see [VISION.md](../../VISION.md)) needs the choice per workspace: one team's private workspace must be closed while another workspace on the same relay stays open, and a workspace that was open must be closable, and the reverse, by its owner without an operator.

## Kinds

| Kind | Name | Signer | Purpose |
|------|------|--------|---------|
| `9034` | Set Workspace Access | owner | Command: make the workspace open or invite-only |

## Event Format

### `kind:9034` Set Workspace Access

```jsonc
{
  "kind": 9034,
  "pubkey": "<owner-pubkey-hex>",
  "content": "",
  "tags": [
    ["access", "invite_only"]
  ]
}
```

- exactly one `access` tag, whose value MUST be `open` or `invite_only`. Any other value, or a missing tag, MUST be rejected; a relay MUST NOT guess.
- `content` is empty and carries no meaning.

## Relay Processing

When a relay receives a `kind:9034` command it MUST:

1. Verify the event signature, NIP-42/NIP-98 authentication, and that `created_at` is within a short window of the relay's clock (120 seconds RECOMMENDED), as for the NIP-43 commands.
2. Verify the actor holds the **`owner`** role in the workspace's member list. An `admin` MUST be refused: deciding who may join is the owner's call. Command kinds `9030`–`9033` are unaffected.
3. Store the setting for this workspace only, and make it take effect on the next request. A relay that caches the setting MUST NOT answer from a stale cache for an authoritative admission check.

The setting is **in addition to** the relay-wide NIP-43 requirement: when the relay requires membership for every workspace, every workspace is invite-only whatever its own setting says. A setting that cannot be read MUST be treated as invite-only (fail closed); a workspace with no stored setting is open.

### Closing

When a workspace becomes invite-only the relay MUST end the live sessions, on every relay process serving it, of everyone who is not a member (an agent admitted through a member's NIP-OA delegation counts through its owner), including audio sessions. Members stay connected. A relay process that did not hear of the change MUST still enforce it within its periodic liveness check, once per change. Opening a workspace ends nobody's session.

## Reading the Setting

The relay's NIP-11 document carries `access`: `"open"` or `"invite_only"`, for the workspace the request's host resolves to. A host that resolves to no workspace, or a setting that cannot be read, gets no `access` field; clients MUST NOT treat a missing field as `open`. A client SHOULD read it before signing in, so that a person who is not a member is told the workspace is invite-only and to ask for an invite, instead of seeing a failed connection.

An invite-only workspace SHOULD list NIP-43 in `supported_nips` (it has a member list and invites, whether or not the whole relay requires membership), when the relay has the stable signing key those events are verified against.

An invite-only workspace MUST NOT appear in any unauthenticated directory of workspaces the relay publishes.

## Security Considerations

The setting is public by design: NIP-11 is unauthenticated, and a person needs to know a workspace is private to know to ask for an invite. It reveals nothing else. Closing is enforced at every way in (WebSocket sign-in, HTTP, git, audio) by one shared check, so no transport can be left open by omission. Owner-only authorization means an admin cannot lock the owner's workspace, or open a private one. A replayed command inside the freshness window sets the same value it already set.

## Relation to Other NIPs

- **NIP-11**: supplies the document `access` is added to.
- **NIP-43**: supplies the member list and roles the setting is checked against, and the invite flow that adds members.
- **NIP-WP**: the neighbouring workspace-level command (`kind:9033`, icon), signed by an admin or owner. This NIP is owner-only.
