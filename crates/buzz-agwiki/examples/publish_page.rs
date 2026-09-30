//! Dogfood helper (not shipped): publish a wiki page whose body carries
//! `decision` blocks, so the persona drafting loop can run live end to end —
//! `buzz agwiki draft` materializes the blocks as `agent-draft` records.
//!
//!   BUZZ_RELAY_URL=ws://localhost:3000 BUZZ_E2E_KEY=<hex-or-nsec> \
//!     cargo run -p buzz-agwiki --example publish_page -- <space> [<body-file>]
//!
//! Without a body file a built-in fixture is used (two honest decision
//! blocks + one the composer must skip — the verbatim-evidence rule in the
//! wild). The page lands at `<space>/standup` (kind:44002), the same
//! envelope the distill loop publishes through.
use std::time::{SystemTime, UNIX_EPOCH};

use nostr::Keys;

use buzz_agwiki::{build_agent_wiki_builder, compose_page};

const FIXTURE_BODY: &str = r#"## Standup

The round-2 postmortem asks for a 600 bps quorum.
Sell pressure is capped at 15% per epoch today.

```decision
title: Raise proposal quorum to 600 bps
kind: plain
evidence: The round-2 postmortem asks for a 600 bps quorum.
```

```decision
title: Document the sell-rate gate
kind: plain
evidence: Sell pressure is capped at 15% per epoch today.
```

```decision
title: Invent a number (the composer must skip this one)
kind: plain
evidence: The quorum is 999 bps and everyone agrees.
```
"#;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let space = std::env::args().nth(1).unwrap_or_else(|| "default".into());
    let body = match std::env::args().nth(2) {
        Some(path) => std::fs::read_to_string(path)?,
        None => FIXTURE_BODY.to_string(),
    };
    // Optional: the page slug (default `standup`) and the provenance `model`
    // tag (default `e2e-fixture`) — a trained skill publishes as
    // `<space>/skill-distill` with its training provenance in `model:`.
    let slug = std::env::args().nth(3).unwrap_or_else(|| "standup".into());
    let model = std::env::args()
        .nth(4)
        .unwrap_or_else(|| "e2e-fixture".into());
    let keys = Keys::parse(
        std::env::var("BUZZ_E2E_KEY")
            .expect("BUZZ_E2E_KEY (hex secret key or nsec)")
            .trim(),
    )?;
    let relay = std::env::var("BUZZ_RELAY_URL").unwrap_or_else(|_| "ws://localhost:3000".into());

    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let page = compose_page(&space, &body, &model, 1);
    let builder = build_agent_wiki_builder(&format!("{space}/{slug}"), &page, &model, 0, &[])?;
    let event = builder.sign_with_keys(&keys)?;

    let mut ws = buzz_ws_client::NostrWsConnection::connect(&relay).await?;
    ws.authenticate(&keys, None).await?;
    let result = ws.send_event(event.clone()).await?;
    println!(
        "published page d={space}/{slug} id={} accepted={} at={now}",
        event.id.to_hex(),
        result.accepted
    );
    Ok(())
}
