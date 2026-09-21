//! Throwaway E2E helper (not shipped): publish an open kind:44011 task the
//! fleet worker should claim, and verify the resulting flow.
//!
//! Post mode (worker key doubles as the poster — it is already a member):
//!   BUZZ_RELAY_URL=ws://localhost:3000 BUZZ_FLEET_WORKER_KEY=<hex> \
//!     cargo run -p buzz-fleet-worker --example post_task -- post "<title>" "<description>"
//!
//! Verify mode (task event id from post mode):
//!   ... --example post_task -- verify <task-event-id-hex>
use std::time::{Duration, Instant};

use nostr::{EventBuilder, Keys, Tag};
use serde_json::json;

fn t(src: &str, v: &str) -> Tag {
    Tag::parse([src, v]).expect("tag")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "post".into());
    let keys = Keys::parse(
        std::env::var("BUZZ_FLEET_WORKER_KEY")
            .expect("BUZZ_FLEET_WORKER_KEY")
            .trim(),
    )?;
    let relay = std::env::var("BUZZ_RELAY_URL").unwrap_or_else(|_| "ws://localhost:3000".into());
    let mut ws = buzz_ws_client::NostrWsConnection::connect(&relay).await?;
    ws.authenticate(&keys, None).await?;
    let pk = keys.public_key().to_hex();

    if mode == "post" {
        let title = std::env::args().nth(2).unwrap_or_else(|| "E2E task".into());
        let description = std::env::args().nth(3).unwrap_or_else(|| {
            "Live end-to-end check of the fleet worker LLM + auto-credit flow.".into()
        });

        // Pick a live channel h from recent messages so the ✅ turn lands somewhere.
        ws.send_raw(&json!(["REQ", "chan", { "kinds": [40002], "limit": 10 }]))
            .await?;
        let mut h: Option<String> = None;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match ws.next_event(Duration::from_millis(500)).await {
                Ok(buzz_ws_client::RelayMessage::Event { event, .. }) => {
                    for tag in event.tags.iter() {
                        let parts = tag.as_slice();
                        if parts.len() >= 2 && parts[0] == "h" && !parts[1].is_empty() {
                            h = Some(parts[1].clone());
                            break;
                        }
                    }
                    if h.is_some() {
                        break;
                    }
                }
                Ok(buzz_ws_client::RelayMessage::Eose { .. }) => break,
                _ => break,
            }
        }
        let _ = ws.send_raw(&json!(["CLOSE", "chan"])).await;

        let d = uuid::Uuid::new_v4().to_string();
        let mut tags = vec![t("d", &d), t("p", &pk)];
        let h = h.or_else(|| std::env::var("BUZZ_E2E_H").ok().filter(|v| !v.is_empty()));
        if let Some(h) = &h {
            tags.push(t("h", h));
        }
        let content = json!({
            "title": title,
            "description": description,
            "status": "open",
            "priority": "normal",
        })
        .to_string();
        let event = EventBuilder::new(nostr::Kind::Custom(44011), content)
            .tags(tags)
            .sign_with_keys(&keys)?;
        let result = ws.send_event(event).await?;
        println!(
            "posted task d={d} h={h:?} accepted={} id={}",
            result.accepted,
            result.event_id.as_str()
        );
        return Ok(());
    }

    // verify mode
    let task_event_id = std::env::args()
        .nth(2)
        .expect("verify needs the task event id (hex)");

    // 1) task rows for this d
    ws.send_raw(
        &json!(["REQ", "v-tasks", { "kinds": [44011], "#d": [task_event_id], "limit": 20 }]),
    )
    .await?;
    // 2) contribution records crediting this task
    ws.send_raw(
        &json!(["REQ", "v-contrib", { "kinds": [37013], "#d": [task_event_id], "limit": 5 }]),
    )
    .await?;
    // 3) recent turns by the worker (the ✅ Done post)
    ws.send_raw(&json!(["REQ", "v-turns", { "kinds": [40002], "authors": [pk], "limit": 5 }]))
        .await?;

    let mut tasks = Vec::new();
    let mut contribs = Vec::new();
    let mut turns = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline {
        match tokio::time::timeout(
            Duration::from_millis(1200),
            ws.next_event(Duration::from_millis(1200)),
        )
        .await
        {
            Ok(Ok(buzz_ws_client::RelayMessage::Event { event, .. })) => {
                match u16::from(event.kind) as u32 {
                    44011 => tasks.push((*event).clone()),
                    37013 => contribs.push((*event).clone()),
                    40002 => turns.push((*event).clone()),
                    _ => {}
                }
            }
            Ok(Ok(buzz_ws_client::RelayMessage::Eose { .. })) => {}
            _ => {}
        }
        if Instant::now() > deadline {
            break;
        }
    }
    let _ = ws.send_raw(&json!(["CLOSE", "v-tasks"])).await;
    let _ = ws.send_raw(&json!(["CLOSE", "v-contrib"])).await;
    let _ = ws.send_raw(&json!(["CLOSE", "v-turns"])).await;

    tasks.sort_by_key(|e| e.created_at.as_secs());
    println!("== task rows ({}):", tasks.len());
    for e in &tasks {
        println!(
            "  {} {}: {}",
            e.created_at.as_secs(),
            &e.pubkey.to_hex()[..8],
            e.content
        );
    }
    println!("== contribution records ({}):", contribs.len());
    for e in &contribs {
        println!(
            "  d={} author={}",
            {
                let mut d = String::new();
                for tag in e.tags.iter() {
                    let parts = tag.as_slice();
                    if parts.len() >= 2 && parts[0] == "d" {
                        d = parts[1].clone();
                    }
                }
                d
            },
            &e.pubkey.to_hex()[..8]
        );
        println!("  content: {}", e.content);
    }
    println!("== recent worker turns ({}):", turns.len());
    for e in turns.iter().rev().take(3) {
        println!(
            "  {} {}",
            e.created_at.as_secs(),
            e.content.chars().take(160).collect::<String>()
        );
    }
    Ok(())
}
