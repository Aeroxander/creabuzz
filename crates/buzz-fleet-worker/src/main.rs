//! buzz-fleet-worker — the always-on sandbox fleet worker.
//!
//! A Rust process that lives on the relay host as another fleet member:
//! advertises capabilities (kind:44010, runtype=sandbox), polls for
//! kind:44011 tasks assigned to it, answers through the relay's LLM
//! gateway (NIP-98-signed, key stays server-side), and publishes the task
//! lifecycle (in_progress -> done) plus in-channel ✅ turns.
//!
//! No Node, no extra servers: the relay is the only service; this binary is
//! just another pubkey.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use nostr::{Event, EventBuilder, Keys, Tag};
use serde_json::{json, Value};

const ANNOUNCE_INTERVAL: Duration = Duration::from_secs(60);
const POLL_INTERVAL: Duration = Duration::from_secs(12);
const REQ_TIMEOUT: Duration = Duration::from_secs(5);

fn keys() -> Keys {
    if let Ok(hex_sk) = std::env::var("BUZZ_FLEET_WORKER_KEY") {
        let sk = hex_sk.trim();
        if let Ok(keys) = Keys::parse(sk) {
            return keys;
        }
        eprintln!(
            "BUZZ_FLEET_WORKER_KEY invalid; generating a new key (state is lost unless saved)."
        );
    }
    Keys::generate()
}

fn t(src: &str, v: &str) -> Tag {
    Tag::parse([src, v]).expect("tag")
}

fn tags_for(
    event: &Event,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let mut d = None;
    let mut p = None;
    let mut h = None;
    let mut e = None;
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        if parts.len() >= 2 {
            match parts[0].as_str() {
                "d" => d = Some(parts[1].clone()),
                "p" => p = Some(parts[1].clone()),
                "h" => h = Some(parts[1].clone()),
                "e" => e = Some(parts[1].clone()),
                _ => {}
            }
        }
    }
    (d, p, h, e)
}

fn task_status(event: &Event) -> String {
    serde_json::from_str::<Value>(&event.content)
        .ok()
        .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(String::from))
        .unwrap_or_default()
}

fn task_title(event: &Event) -> String {
    serde_json::from_str::<Value>(&event.content)
        .ok()
        .and_then(|v| v.get("title").and_then(|s| s.as_str()).map(String::from))
        .unwrap_or_else(|| event.content.chars().take(80).collect())
}

async fn announce(ws: &mut buzz_ws_client::NostrWsConnection, keys: &Keys, name: &str) {
    let team = std::env::var("BUZZ_FLEET_WORKER_TEAM")
        .ok()
        .unwrap_or_default();
    let content = json!({
        "name": name,
        "runtype": "sandbox",
        "status": "available",
        "tools": ["fleet", "chat", "wiki", "search"],
        "team": team,
        "heartbeat": now_secs(),
    })
    .to_string();
    let event = EventBuilder::new(nostr::Kind::Custom(44010), content)
        .tags(vec![t("d", &keys.public_key().to_hex())])
        .sign_with_keys(keys)
        .expect("announce sign");
    match ws.send_event(event).await {
        Ok(ok) if ok.accepted => {}
        other => eprintln!("announce failed: {:?}", other.ok().map(|o| o.message)),
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

async fn publish_task_row(
    ws: &mut buzz_ws_client::NostrWsConnection,
    keys: &Keys,
    task: &Event,
    status: &str,
) {
    let (d, _, h, e) = tags_for(task);
    let Some(d) = d else { return };
    let mut tags = vec![t("d", &d), t("p", &keys.public_key().to_hex())];
    if let Some(h) = &h {
        tags.push(t("h", h));
    }
    if let Some(e) = &e {
        tags.push(t("e", e));
    }
    let content = json!({
        "title": task_title(task),
        "description": "",
        "status": status,
    })
    .to_string();
    let event = EventBuilder::new(nostr::Kind::Custom(44011), content)
        .tags(tags)
        .sign_with_keys(keys)
        .expect("task row sign");
    let _ = ws.send_event(event).await;
}

async fn post_turn(
    ws: &mut buzz_ws_client::NostrWsConnection,
    keys: &Keys,
    channel: Option<&str>,
    parent: Option<&str>,
    content: &str,
) {
    let mut tags = Vec::new();
    if let Some(h) = channel {
        tags.push(t("h", h));
    }
    if let Some(e) = parent {
        tags.push(t("e", e));
    }
    let event = EventBuilder::new(nostr::Kind::Custom(40002), content.to_string())
        .tags(tags)
        .sign_with_keys(keys)
        .expect("turn sign");
    let _ = ws.send_event(event).await;
}

/// OpenAI-compatible chat completion via the relay gateway with NIP-98 auth.
async fn ask_gateway(
    client: &reqwest::Client,
    keys: &Keys,
    prompt: &str,
) -> Result<String, String> {
    // Gateway host must match the community-bound host (localhost since the
    // tenant migration) so the relay can resolve the community for the request.
    let gateway = std::env::var("BUZZ_FLEET_WORKER_GATEWAY")
        .unwrap_or_else(|_| "http://localhost:3000/llm/chat/completions".into());
    let model = std::env::var("BUZZ_FLEET_WORKER_MODEL")
        .unwrap_or_else(|_| "umans-deepseek-v4-flash-0731".into());
    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": "You are a sandbox fleet worker in a Buzz community. Complete the task concisely." },
            { "role": "user", "content": prompt },
        ],
        "max_tokens": 4096,
    })
    .to_string();

    // NIP-98: kind 27235 signed by the worker key.
    let payload_sha = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(body.as_bytes());
        hex::encode(hasher.finalize())
    };
    let mut nonce = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce);
    let nonce_hex = hex::encode(nonce);
    let auth = EventBuilder::new(nostr::Kind::HttpAuth, "")
        .tags(vec![
            t("u", &gateway),
            t("method", "POST"),
            t("payload", &payload_sha),
            t("nonce", &nonce_hex),
        ])
        .sign_with_keys(keys)
        .map_err(|e| e.to_string())?;
    let auth_b64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        serde_json::to_string(&auth).map_err(|e| e.to_string())?,
    );
    let header = format!("Nostr {auth_b64}");

    let resp = client
        .post(&gateway)
        .header("Content-Type", "application/json")
        .header("Authorization", header)
        .body(body)
        .timeout(Duration::from_secs(240))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let json: Value = resp
        .json()
        .await
        .map_err(|e| format!("bad upstream: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "gateway {status}: {}",
            json.get("error").and_then(|v| v.as_str()).unwrap_or("")
        ));
    }
    json.get("choices")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "empty LLM response".into())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()))
        .init();

    let keys = keys();
    let name = std::env::var("BUZZ_FLEET_WORKER_NAME").unwrap_or_else(|_| "sandbox".into());
    let relay_url =
        std::env::var("BUZZ_RELAY_URL").unwrap_or_else(|_| "ws://localhost:3000".into());
    tracing::info!(pubkey = %keys.public_key().to_hex(), "fleet worker starting");

    let client = reqwest::Client::new();
    let mut ws = buzz_ws_client::NostrWsConnection::connect(&relay_url).await?;
    ws.authenticate(&keys, None).await?;

    let mut processed: HashSet<String> = HashSet::new();
    let mut last_announce = Instant::now() - ANNOUNCE_INTERVAL;

    loop {
        if last_announce.elapsed() >= ANNOUNCE_INTERVAL {
            announce(&mut ws, &keys, &name).await;
            last_announce = Instant::now();
        }

        // Poll for tasks assigned to us.
        ws.send_raw(&json!(["REQ", "worker-poll", { "kinds": [44011], "limit": 100 }]))
            .await?;
        let spawned: Vec<Event> = {
            let mut found = Vec::new();
            let deadline = Instant::now() + REQ_TIMEOUT;
            while Instant::now() < deadline {
                match ws.next_event(Duration::from_millis(1500)).await {
                    Ok(buzz_ws_client::RelayMessage::Event { event, .. }) => {
                        found.push(*event);
                    }
                    Ok(buzz_ws_client::RelayMessage::Eose { .. }) => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            let _ = ws.send_raw(&json!(["CLOSE", "worker-poll"])).await;
            found
        };

        for event in spawned {
            let (d, p, h, e) = tags_for(&event);
            let Some(d) = d else { continue };
            let status = task_status(&event);
            let mine = p.as_deref() == Some(keys.public_key().to_hex().as_str());
            // Autonomy: claim unassigned open tasks so the fleet keeps moving.
            let is_open_unclaimed = status == "open" && p.is_none();
            if (!mine && !is_open_unclaimed) || !matches!(status.as_str(), "open" | "assigned") {
                continue;
            }
            if !processed.insert(d.clone()) {
                continue;
            }
            let title = task_title(&event);
            if is_open_unclaimed {
                publish_task_row(&mut ws, &keys, &event, "assigned").await;
                tracing::info!(task = %d, "claiming open task: {title}");
            }
            tracing::info!(task = %d, "picking up task: {title}");

            publish_task_row(&mut ws, &keys, &event, "in_progress").await;
            if let Some(h) = &h {
                post_turn(
                    &mut ws,
                    &keys,
                    Some(h),
                    e.as_deref(),
                    &format!("⚙️ Working: {title}"),
                )
                .await;
            }
            let mut answer_attempts = 0;
            let llm_result = loop {
                answer_attempts += 1;
                match ask_gateway(
                    &client,
                    &keys,
                    &format!("Task: {title}\n\n{}", event.content),
                )
                .await
                {
                    Ok(answer) => break Ok(answer),
                    Err(err) if answer_attempts < 3 && err.contains("empty LLM response") => {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                    Err(err) => break Err(err),
                }
            };
            match llm_result {
                Ok(answer) => {
                    publish_task_row(&mut ws, &keys, &event, "done").await;
                    post_turn(
                        &mut ws,
                        &keys,
                        h.as_deref(),
                        e.as_deref(),
                        &format!(
                            "✅ Done: {title}

{answer}"
                        ),
                    )
                    .await;
                    tracing::info!(task = %d, "completed");
                }
                Err(err) => {
                    tracing::warn!(task = %d, "failed: {err}");
                    post_turn(
                        &mut ws,
                        &keys,
                        h.as_deref(),
                        e.as_deref(),
                        &format!("⚠️ Task failed: {err}"),
                    )
                    .await;
                }
            }
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}
