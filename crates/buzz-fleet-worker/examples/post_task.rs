//! Throwaway E2E helper (not shipped): publish an open kind:44011 task the
//! fleet worker should claim, and verify the resulting flow.
//!
//! Post mode (worker key doubles as the poster — it is already a member):
//!   BUZZ_RELAY_URL=ws://localhost:3000 BUZZ_FLEET_WORKER_KEY=<hex> \
//!     cargo run -p buzz-fleet-worker --example post_task -- post "<title>" "<description>"
//!   Optional channel: BUZZ_E2E_H=<channel uuid>
//!
//! Verify mode (task d-tag uuid from post mode):
//!   ... --example post_task -- verify <task-d-uuid>
use std::time::{Duration, Instant};

use nostr::{EventBuilder, Keys, Tag};
use serde_json::json;

fn t(src: &str, v: &str) -> Tag {
    Tag::parse([src, v]).expect("tag")
}

async fn collect_events(
    ws: &mut buzz_ws_client::NostrWsConnection,
    sub: &str,
    kind: u32,
    seconds: u64,
) -> Vec<nostr::Event> {
    let mut found = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        if let Ok(Ok(buzz_ws_client::RelayMessage::Event { event, .. })) = tokio::time::timeout(
            Duration::from_millis(500),
            ws.next_event(Duration::from_millis(500)),
        )
        .await
        {
            if u16::from(event.kind) as u32 == kind {
                found.push((*event).clone());
            }
        }
        if Instant::now() > deadline {
            break;
        }
    }
    let _ = ws.send_raw(&json!(["CLOSE", sub])).await;
    found
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

        // Channel: from recent messages, or BUZZ_E2E_H.
        ws.send_raw(&json!(["REQ", "chan", { "kinds": [40002], "limit": 10 }]))
            .await?;
        let mut h: Option<String> = None;
        for event in collect_events(&mut ws, "chan", 40002, 4).await {
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
        let h = h.or_else(|| std::env::var("BUZZ_E2E_H").ok().filter(|v| !v.is_empty()));

        let d = uuid::Uuid::new_v4().to_string();
        let mut tags = vec![t("d", &d), t("p", &pk)];
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
        println!("posted task d={d} h={h:?} accepted={}", result.accepted);
        return Ok(());
    }

    if mode == "gateway" {
        // Mirrors web/src/features/fleet/browser-agent.ts: NIP-98 auth header,
        // model name in the body, relay injects the upstream URL + key.
        let url = "http://localhost:3000/llm/chat/completions";
        let body = json!({
            "model": "glm-5.3-flash",
            "messages": [
                { "role": "user", "content": "Reply with the single word: gateway-ok" }
            ],
            "max_tokens": 512,
        });
        let body_str = serde_json::to_string(&body)?;
        use sha2::{Digest, Sha256};
        let payload_sha = hex::encode(Sha256::digest(body_str.as_bytes()));
        let mut nonce = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce);
        let auth = EventBuilder::new(nostr::Kind::HttpAuth, "")
            .tags(vec![
                t("u", url),
                t("method", "POST"),
                t("payload", &payload_sha),
                t("nonce", &hex::encode(nonce)),
            ])
            .sign_with_keys(&keys)?;
        let auth_b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            serde_json::to_string(&auth)?,
        );
        let client = reqwest::Client::new();
        let resp = client
            .post(url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Nostr {auth_b64}"))
            .body(body_str)
            .timeout(Duration::from_secs(120))
            .send()
            .await?;
        let status = resp.status();
        let json: serde_json::Value = resp.json().await?;
        let content = json
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|c| c.first())
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        println!("gateway status={status} content={content:?}");
        return Ok(());
    }

    if mode == "delete" {
        // NIP-09: kind:5 with exactly one e-tag target; must be authored by
        // the target's author (the worker key here).
        let target = std::env::args()
            .nth(2)
            .expect("delete needs a target event id (hex)");
        let event = EventBuilder::new(nostr::Kind::Custom(5), "")
            .tags(vec![t("e", &target)])
            .sign_with_keys(&keys)?;
        let result = ws.send_event(event).await?;
        println!("deletion of {target} accepted={}", result.accepted);
        return Ok(());
    }

    // verify mode: arg is a task d-tag (uuid)
    let task_d = std::env::args()
        .nth(2)
        .expect("verify needs the task d tag (uuid)");

    ws.send_raw(&json!(["REQ", "v-tasks", { "kinds": [44011], "#d": [task_d], "limit": 20 }]))
        .await?;
    let tasks = collect_events(&mut ws, "v-tasks", 44011, 4).await;
    let mut tasks = tasks;
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
    let Some(latest) = tasks.last() else {
        println!("no task rows found for d={task_d}");
        return Ok(());
    };
    println!(
        "latest: {} created={} by {}",
        task_d,
        latest.created_at.as_secs(),
        &latest.pubkey.to_hex()[..8]
    );
    // The contribution record's d = the row the worker picked up (the open
    // row), so query by every row id, not just the newest.
    let row_ids: Vec<String> = tasks.iter().map(|e| e.id.to_hex()).collect();
    println!("row event ids: {row_ids:?}");

    ws.send_raw(&json!(["REQ", "v-contrib", { "kinds": [37013], "#d": row_ids, "limit": 5 }]))
        .await?;
    ws.send_raw(&json!(["REQ", "v-turns", { "kinds": [40002], "authors": [pk], "limit": 5 }]))
        .await?;
    let contribs = collect_events(&mut ws, "v-contrib", 37013, 4).await;
    let turns = collect_events(&mut ws, "v-turns", 40002, 4).await;

    println!("== contribution records ({}):", contribs.len());
    for e in &contribs {
        let mut d = String::new();
        for tag in e.tags.iter() {
            let parts = tag.as_slice();
            if parts.len() >= 2 && parts[0] == "d" {
                d = parts[1].clone();
            }
        }
        println!("  d={d} author={}", &e.pubkey.to_hex()[..8]);
        println!("  content: {}", e.content);
    }
    println!("== recent worker turns ({}):", turns.len());
    for e in turns.iter().rev().take(4) {
        println!(
            "  {} {}",
            e.created_at.as_secs(),
            e.content.chars().take(160).collect::<String>()
        );
    }
    Ok(())
}
