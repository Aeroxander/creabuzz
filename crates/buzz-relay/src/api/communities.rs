//! Community directory — the unauthenticated discovery surface.
//!
//! `GET /communities` lists every active community hosted by this deployment:
//! host, display name, description, workspace icon, member count, archived
//! flag. This is the browse-before-join entry point for the web client (the
//! Flotilla-style "relays as groups" discovery model). It is deliberately
//! unauthenticated and never reveals signing keys, tokens, or membership
//! identities beyond the public aggregate count.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;

use crate::state::AppState;

/// One community in the directory.
#[derive(Debug, Serialize)]
pub struct DirectoryEntry {
    /// Normalized host that maps to this community (also its WebSocket
    /// origin for clients that join it).
    pub host: String,
    /// Relay-level display name. Community-specific display metadata is a
    /// follow-up once communities publish NIP-29 group metadata; until then
    /// this mirrors the NIP-11 default in `nip11.rs`.
    pub name: &'static str,
    /// Relay-level description (see `name`).
    pub description: &'static str,
    /// Workspace icon URL when configured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Number of relay members (public aggregate).
    pub member_count: i64,
    /// True when the community was archived by its owner.
    pub archived: bool,
}

/// Response body for `GET /communities`.
#[derive(Debug, Serialize)]
pub struct DirectoryResponse {
    /// Directory entries, one per active community on this deployment.
    pub communities: Vec<DirectoryEntry>,
}

/// `GET /communities` — unauthenticated community discovery.
pub(crate) async fn directory(
    State(state): State<std::sync::Arc<AppState>>,
) -> Result<Json<DirectoryResponse>, StatusCode> {
    let records = state
        .db
        .list_directory_communities()
        .await
        .map_err(|error| {
            tracing::error!(?error, "community directory lookup failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    let communities = records
        .into_iter()
        .map(|record| DirectoryEntry {
            host: record.host,
            name: "Buzz Relay",
            description: "Buzz — private team communication relay",
            icon: record.icon,
            member_count: record.member_count,
            archived: record.archived,
        })
        .collect();

    Ok(Json(DirectoryResponse { communities }))
}
