//! Inviting a community member into Paperclip, through Buzz.
//!
//! Paperclip invites are **copy-link only**: there is no recipient field and no
//! email is sent, and there is no API to pre-provision a member. The documented
//! flow is "you share the link yourself". A community already has a channel for
//! sharing things, so the bridge mints the invite and posts the link where the
//! member is.
//!
//! An invite is single-use and expires (72 hours by default). Two rules follow,
//! and both are enforced here rather than left to the caller:
//!
//! * **A message is never posted without a working link.** A "join here" post
//!   with no link is worse than no post, because it looks actionable.
//! * **The two invite kinds point at different documents.** A person follows the
//!   invite URL; an agent follows the onboarding text document.

use serde::{Deserialize, Serialize};

use crate::paperclip_write::{normalize_api_key, WriteError};

/// Who an invite is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InviteKind {
    /// A human joins through the invite URL.
    Human,
    /// An agent follows the onboarding text document.
    Agent,
    /// Either may use the link.
    Both,
}

impl InviteKind {
    /// The value Paperclip's validator expects.
    pub fn as_str(self) -> &'static str {
        match self {
            InviteKind::Human => "human",
            InviteKind::Agent => "agent",
            InviteKind::Both => "both",
        }
    }
}

/// The roles a human invite may carry.
pub const HUMAN_ROLES: [&str; 4] = ["viewer", "operator", "admin", "owner"];

/// Validate a requested human role.
pub fn human_role(raw: &str) -> Result<String, String> {
    let normalised = raw.trim().to_ascii_lowercase();
    if HUMAN_ROLES.contains(&normalised.as_str()) {
        Ok(normalised)
    } else {
        Err(format!(
            "`{raw}` is not a company role; expected one of {}",
            HUMAN_ROLES.join(", ")
        ))
    }
}

/// What to ask Paperclip for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteRequest {
    /// Who the invite admits.
    pub allowed_join_types: &'static str,
    /// Role the human lands in, when it is a human invite.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub human_role: Option<String>,
}

impl InviteRequest {
    /// A human invite for `role`.
    pub fn human(role: &str) -> Result<Self, String> {
        Ok(Self {
            allowed_join_types: InviteKind::Human.as_str(),
            human_role: Some(human_role(role)?),
        })
    }

    /// An agent invite.
    pub fn agent() -> Self {
        Self {
            allowed_join_types: InviteKind::Agent.as_str(),
            human_role: None,
        }
    }
}

/// An invite Paperclip created.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedInvite {
    /// The invite token. Treat as a secret: anyone with it can join.
    #[serde(default)]
    pub token: String,
    /// Link a person opens.
    #[serde(default)]
    pub invite_url: Option<String>,
    /// Plain-text onboarding document an agent follows.
    #[serde(default)]
    pub onboarding_text_url: Option<String>,
    /// When the invite stops working.
    #[serde(default)]
    pub expires_at: Option<String>,
    /// Company the invite is for.
    #[serde(default)]
    pub company_name: Option<String>,
}

/// Where invites are created.
pub trait InviteIssuer {
    /// Create an invite.
    fn create_invite(
        &self,
        request: &InviteRequest,
    ) -> impl std::future::Future<Output = Result<CreatedInvite, WriteError>> + Send;
}

/// Creates invites over HTTP with a board key.
#[derive(Debug, Clone)]
pub struct RestInviteIssuer {
    base_url: String,
    company_id: String,
    api_key: Option<String>,
    client: reqwest::Client,
}

impl RestInviteIssuer {
    /// Build an issuer for one company.
    ///
    /// Creating an invite needs the `users:invite` permission: a viewer key
    /// cannot do it, so this is a write credential.
    pub fn new(
        base_url: impl Into<String>,
        company_id: impl Into<String>,
        api_key: impl Into<String>,
    ) -> Result<Self, crate::BridgeError> {
        let base_url = base_url.into();
        url::Url::parse(&base_url).map_err(|error| {
            crate::BridgeError::Config(format!("invalid Paperclip base URL {base_url}: {error}"))
        })?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            company_id: company_id.into(),
            api_key: normalize_api_key(api_key.into()),
            client: reqwest::Client::new(),
        })
    }
}

impl InviteIssuer for RestInviteIssuer {
    async fn create_invite(&self, request: &InviteRequest) -> Result<CreatedInvite, WriteError> {
        let url = format!(
            "{}/api/companies/{}/invites",
            self.base_url, self.company_id
        );
        let mut http = self
            .client
            .post(&url)
            .header("accept", "application/json")
            .json(request);
        if let Some(api_key) = self.api_key.as_deref() {
            http = http.bearer_auth(api_key);
        }
        let response = http
            .send()
            .await
            .map_err(|error| WriteError::Transport(error.to_string()))?;
        let status = response.status().as_u16();
        let body = response
            .text()
            .await
            .map_err(|error| WriteError::Transport(format!("cannot read body: {error}")))?;
        if !(200..300).contains(&status) {
            let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
            return Err(WriteError::Status {
                code: status,
                code_name: parsed
                    .get("code")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
                message: parsed
                    .get("error")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| body.chars().take(200).collect()),
            });
        }
        serde_json::from_str(&body)
            .map_err(|error| WriteError::Transport(format!("unexpected invite response: {error}")))
    }
}

/// Compose the message posted into the community.
///
/// Errors when there is no link to share: posting an invitation with nothing to
/// act on would be worse than posting nothing.
pub fn invite_message(
    requested_role: Option<&str>,
    invite: &CreatedInvite,
) -> Result<String, crate::BridgeError> {
    let company = invite
        .company_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("the team");
    let expiry = invite
        .expires_at
        .as_deref()
        .map(|value| format!(" It expires {value}."))
        .unwrap_or_default();

    match (
        invite.invite_url.as_deref(),
        invite.onboarding_text_url.as_deref(),
    ) {
        (Some(url), _) => {
            let role = requested_role
                .map(|role| format!(" Role: {role}."))
                .unwrap_or_default();
            Ok(format!(
                "Join the Paperclip workspace for {company}: {url}{role} Single use.{expiry}"
            ))
        }
        (None, Some(onboarding)) => Ok(format!(
            "Agent invite for the Paperclip workspace of {company}. Onboarding document: \
             {onboarding}{expiry}"
        )),
        (None, None) => Err(crate::BridgeError::Source(
            "Paperclip returned an invite with no link, so there is nothing to share".to_string(),
        )),
    }
}

/// Publishes a chat message into a Buzz channel.
///
/// Separate from [`crate::Publisher`]: a task row and a message are different
/// event shapes, and the invite flow posts a message.
pub trait MessagePublisher {
    /// Post `text` into `channel`, returning the event id.
    fn publish_message(
        &self,
        channel: &str,
        text: &str,
    ) -> impl std::future::Future<Output = Result<String, crate::BridgeError>> + Send;
}

/// Posts messages through the relay as the bridge identity.
#[derive(Debug, Clone)]
pub struct RelayMessagePublisher {
    relay: crate::relay::RelayPublisher,
    keys: nostr::Keys,
}

impl RelayMessagePublisher {
    /// Build a publisher for `relay`, signing as `keys`.
    pub fn new(relay: crate::relay::RelayPublisher, keys: nostr::Keys) -> Self {
        Self { relay, keys }
    }
}

impl MessagePublisher for RelayMessagePublisher {
    async fn publish_message(
        &self,
        channel: &str,
        text: &str,
    ) -> Result<String, crate::BridgeError> {
        let channel_id = uuid::Uuid::parse_str(channel.trim()).map_err(|error| {
            crate::BridgeError::Config(format!("`{channel}` is not a channel UUID: {error}"))
        })?;
        // Built through the SDK so the message carries the same `h` tag and
        // content limits every other Buzz client applies.
        let event = buzz_sdk::build_message(channel_id, text, None, &[], false, &[], &[])
            .map_err(|error| crate::BridgeError::Config(error.to_string()))?
            .sign_with_keys(&self.keys)
            .map_err(|error| crate::BridgeError::Sign(error.to_string()))?;
        let outcome = self.relay.publish_event(event).await?;
        if !outcome.accepted {
            return Err(crate::BridgeError::Publish(outcome.message));
        }
        Ok(outcome.event_id.unwrap_or_default())
    }
}

/// What happened when a member was invited.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteOutcome {
    /// Link a person opens, when Paperclip returned one.
    pub invite_url: Option<String>,
    /// Onboarding document for an agent.
    pub onboarding_text_url: Option<String>,
    /// When the invite stops working.
    pub expires_at: Option<String>,
    /// The message that was, or would be, posted.
    pub message: String,
    /// Event id of the announcement, when it was posted.
    pub posted_event_id: Option<String>,
    /// Why the announcement failed, when it did.
    pub post_error: Option<String>,
    /// Whether this was a rehearsal.
    pub dry_run: bool,
}

/// Create an invite and announce it in a channel.
///
/// If the invite is created but the announcement fails, the outcome still
/// carries the link and reports the failure: the invite is real and single-use,
/// so discarding its URL because a message failed would strand it.
pub async fn invite_member<I, P>(
    issuer: &I,
    publisher: &P,
    channel: &str,
    request: &InviteRequest,
    dry_run: bool,
) -> Result<InviteOutcome, crate::BridgeError>
where
    I: InviteIssuer,
    P: MessagePublisher,
{
    if dry_run {
        return Ok(InviteOutcome {
            invite_url: None,
            onboarding_text_url: None,
            expires_at: None,
            message: format!(
                "[dry run] would create a `{}` invite and post the link into channel {channel}",
                request.allowed_join_types
            ),
            posted_event_id: None,
            post_error: None,
            dry_run: true,
        });
    }

    let invite = issuer.create_invite(request).await.map_err(|error| {
        crate::BridgeError::Source(format!("cannot create invite: {}", error.label()))
    })?;
    let message = invite_message(request.human_role.as_deref(), &invite)?;

    let (posted_event_id, post_error) = match publisher.publish_message(channel, &message).await {
        Ok(event_id) => (Some(event_id), None),
        Err(error) => (None, Some(error.to_string())),
    };
    Ok(InviteOutcome {
        invite_url: invite.invite_url,
        onboarding_text_url: invite.onboarding_text_url,
        expires_at: invite.expires_at,
        message,
        posted_event_id,
        post_error,
        dry_run: false,
    })
}

#[cfg(test)]
mod announce_tests {
    use super::*;
    use std::sync::Mutex;

    struct FakeIssuer {
        result: Result<CreatedInvite, WriteError>,
        calls: Mutex<Vec<InviteRequest>>,
    }

    impl FakeIssuer {
        fn returning(invite: CreatedInvite) -> Self {
            Self {
                result: Ok(invite),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn failing() -> Self {
            Self {
                result: Err(WriteError::Status {
                    code: 403,
                    code_name: Some("forbidden".to_string()),
                    message: "viewer cannot invite".to_string(),
                }),
                calls: Mutex::new(Vec::new()),
            }
        }
    }

    impl InviteIssuer for FakeIssuer {
        async fn create_invite(
            &self,
            request: &InviteRequest,
        ) -> Result<CreatedInvite, WriteError> {
            self.calls.lock().expect("lock").push(request.clone());
            self.result.clone()
        }
    }

    #[derive(Default)]
    struct RecordingPublisher {
        posted: Mutex<Vec<(String, String)>>,
        fail: bool,
    }

    impl MessagePublisher for RecordingPublisher {
        async fn publish_message(
            &self,
            channel: &str,
            text: &str,
        ) -> Result<String, crate::BridgeError> {
            if self.fail {
                return Err(crate::BridgeError::Publish(
                    "not a channel member".to_string(),
                ));
            }
            self.posted
                .lock()
                .expect("lock")
                .push((channel.to_string(), text.to_string()));
            Ok("evt_1".to_string())
        }
    }

    fn invite() -> CreatedInvite {
        CreatedInvite {
            token: "pcp_invite_x".to_string(),
            invite_url: Some("https://tasks.example.com/invite/pcp_invite_x".to_string()),
            onboarding_text_url: Some("https://tasks.example.com/onboarding.txt".to_string()),
            expires_at: Some("2026-09-21T06:40:10.593Z".to_string()),
            company_name: Some("Test Co".to_string()),
        }
    }

    #[tokio::test]
    async fn an_invite_is_created_and_announced() {
        let issuer = FakeIssuer::returning(invite());
        let publisher = RecordingPublisher::default();
        let request = InviteRequest::human("operator").expect("builds");

        let outcome = invite_member(&issuer, &publisher, "chan-1", &request, false)
            .await
            .expect("invites");

        assert_eq!(outcome.posted_event_id.as_deref(), Some("evt_1"));
        assert!(outcome.post_error.is_none());
        assert!(outcome
            .invite_url
            .as_deref()
            .expect("link")
            .contains("pcp_invite_x"));
        let posted = publisher.posted.lock().expect("lock").clone();
        assert_eq!(posted.len(), 1);
        assert_eq!(posted[0].0, "chan-1");
        assert!(posted[0].1.contains("Role: operator"), "{}", posted[0].1);
        assert_eq!(issuer.calls.lock().expect("lock").len(), 1);
    }

    #[tokio::test]
    async fn a_failed_invite_announces_nothing() {
        let issuer = FakeIssuer::failing();
        let publisher = RecordingPublisher::default();
        let request = InviteRequest::human("operator").expect("builds");

        let error = invite_member(&issuer, &publisher, "chan-1", &request, false)
            .await
            .expect_err("a refused invite is an error");

        assert!(format!("{error}").contains("403"), "{error}");
        assert!(
            publisher.posted.lock().expect("lock").is_empty(),
            "a channel must never be told to join something that was not created"
        );
    }

    #[tokio::test]
    async fn a_failed_announcement_still_reports_the_link() {
        let issuer = FakeIssuer::returning(invite());
        let publisher = RecordingPublisher {
            fail: true,
            ..RecordingPublisher::default()
        };
        let request = InviteRequest::agent();

        let outcome = invite_member(&issuer, &publisher, "chan-1", &request, false)
            .await
            .expect("the invite exists even though the post failed");

        assert!(outcome.posted_event_id.is_none());
        assert!(
            outcome
                .post_error
                .as_deref()
                .unwrap_or_default()
                .contains("channel member"),
            "{:?}",
            outcome.post_error
        );
        assert_eq!(
            outcome.onboarding_text_url.as_deref(),
            Some("https://tasks.example.com/onboarding.txt"),
            "the operator still needs the link to share it another way"
        );
    }

    #[tokio::test]
    async fn a_dry_run_creates_and_posts_nothing() {
        let issuer = FakeIssuer::returning(invite());
        let publisher = RecordingPublisher::default();
        let request = InviteRequest::human("admin").expect("builds");

        let outcome = invite_member(&issuer, &publisher, "chan-1", &request, true)
            .await
            .expect("rehearses");

        assert!(outcome.dry_run);
        assert!(outcome.posted_event_id.is_none());
        assert!(issuer.calls.lock().expect("lock").is_empty());
        assert!(publisher.posted.lock().expect("lock").is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn human_invite() -> CreatedInvite {
        CreatedInvite {
            token: "pcp_invite_x".to_string(),
            invite_url: Some("https://tasks.example.com/invite/pcp_invite_x".to_string()),
            onboarding_text_url: Some(
                "https://tasks.example.com/api/invites/pcp_invite_x/onboarding.txt".to_string(),
            ),
            expires_at: Some("2026-09-21T06:40:10.593Z".to_string()),
            company_name: Some("Buzz Bridge Live Test".to_string()),
        }
    }

    #[test]
    fn a_human_invite_message_carries_the_link_role_and_expiry() {
        let message = invite_message(Some("operator"), &human_invite()).expect("composes");
        assert!(
            message.contains("https://tasks.example.com/invite/pcp_invite_x"),
            "{message}"
        );
        assert!(message.contains("Role: operator"), "{message}");
        assert!(message.contains("Single use"), "{message}");
        assert!(message.contains("2026-09-21T06:40:10.593Z"), "{message}");
        assert!(message.contains("Buzz Bridge Live Test"), "{message}");
        assert!(
            !message.contains("onboarding.txt"),
            "a person is sent to the invite page, not the agent document: {message}"
        );
    }

    #[test]
    fn an_agent_invite_message_points_at_the_onboarding_document() {
        let invite = CreatedInvite {
            invite_url: None,
            ..human_invite()
        };
        let message = invite_message(None, &invite).expect("composes");
        assert!(message.contains("onboarding.txt"), "{message}");
        assert!(message.contains("Agent invite"), "{message}");
    }

    #[test]
    fn an_invite_with_no_link_is_refused() {
        let invite = CreatedInvite {
            invite_url: None,
            onboarding_text_url: None,
            ..human_invite()
        };
        let error = invite_message(None, &invite).expect_err("refused");
        assert!(format!("{error}").contains("nothing to share"), "{error}");
    }

    #[test]
    fn a_company_with_no_name_is_still_readable() {
        let invite = CreatedInvite {
            company_name: None,
            ..human_invite()
        };
        let message = invite_message(Some("viewer"), &invite).expect("composes");
        assert!(message.contains("the team"), "{message}");
    }

    #[test]
    fn human_roles_are_validated_against_the_company_roles() {
        assert_eq!(human_role("Operator").expect("accepted"), "operator");
        for role in HUMAN_ROLES {
            assert_eq!(human_role(role).expect("accepted"), role);
        }
        let error = human_role("superuser").expect_err("rejected");
        assert!(error.contains("expected one of"), "{error}");
    }

    #[test]
    fn requests_carry_the_shape_paperclip_validates() {
        let human = InviteRequest::human("operator").expect("builds");
        let json = serde_json::to_value(&human).expect("json");
        assert_eq!(json["allowedJoinTypes"], "human");
        assert_eq!(json["humanRole"], "operator");

        let agent = InviteRequest::agent();
        let json = serde_json::to_value(&agent).expect("json");
        assert_eq!(json["allowedJoinTypes"], "agent");
        assert!(
            json.get("humanRole").is_none(),
            "an agent invite carries no human role: {json}"
        );
    }
}
