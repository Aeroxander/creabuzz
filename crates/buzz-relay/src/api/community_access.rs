//! Who may join a community: each community's own "people must be members" setting.
//!
//! One server can host many communities, and a team's private workspace must be able to be closed while another
//! community on the same server stays open. The setting lives on the community's row
//! (`communities.membership_required`), is asked through one predicate (`AppState::membership_required`, which also
//! honours the server-wide `BUZZ_REQUIRE_RELAY_MEMBERSHIP`), and is enforced in the one membership check every way in
//! shares (WebSocket sign-in, HTTP, git, audio). These tests pin the properties that matter:
//!
//! - a closed community refuses people who are not members, and an open community on the same server does not care;
//! - the server-wide switch still closes everything;
//! - closing or opening a community takes effect at once, and the final admission fence never reads a stale answer.

#[cfg(test)]
mod postgres_tests {
    use std::sync::Arc;

    use axum::http::StatusCode;
    use buzz_core::CommunityId;
    use nostr::Keys;
    use uuid::Uuid;

    use crate::api::relay_members::{
        check_relay_membership, check_relay_membership_authoritative, MembershipDecision,
    };
    use crate::state::AppState;

    /// A fully wired relay state on the local test Postgres and Redis, with the server-wide switch as asked.
    async fn state(server_wide_membership: bool) -> Arc<AppState> {
        crate::test_support::test_state_with(|config| {
            config.require_relay_membership = server_wide_membership;
        })
        .await
    }

    /// A community owned by `owner`, closed or open.
    async fn community(state: &AppState, owner: &Keys, closed: bool) -> (CommunityId, String) {
        let host = format!("access-{}.example", Uuid::new_v4().simple());
        match state
            .db
            .create_community_with_owner_and_access(&host, &owner.public_key().to_hex(), closed)
            .await
            .expect("create community")
        {
            buzz_db::CreateCommunityWithOwnerResult::Created(record) => (record.id, host),
            other => panic!("expected a created community, got {other:?}"),
        }
    }

    async fn decision(
        state: &AppState,
        community: CommunityId,
        who: &Keys,
        authoritative: bool,
    ) -> MembershipDecision {
        let bytes = who.public_key().to_bytes();
        let result = if authoritative {
            check_relay_membership_authoritative(state, community, &bytes, None, None).await
        } else {
            check_relay_membership(state, community, &bytes, None, None).await
        };
        result.expect("membership check")
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn a_closed_community_refuses_strangers_while_an_open_one_on_the_same_server_does_not() {
        let state = state(false).await;
        let (owner, stranger) = (Keys::generate(), Keys::generate());
        let (closed, _) = community(&state, &owner, true).await;
        let (open, _) = community(&state, &owner, false).await;

        assert_eq!(
            decision(&state, closed, &stranger, false).await,
            MembershipDecision::Denied
        );
        assert_eq!(
            decision(&state, open, &stranger, false).await,
            MembershipDecision::OpenRelay
        );
        // Members are let in to the closed one, and being closed here changes nothing for the open one.
        assert_eq!(
            decision(&state, closed, &owner, false).await,
            MembershipDecision::Member
        );
        assert_eq!(
            decision(&state, open, &owner, false).await,
            MembershipDecision::OpenRelay
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn membership_in_one_community_does_not_open_another() {
        let state = state(false).await;
        let (alice, bob) = (Keys::generate(), Keys::generate());
        let (alices, _) = community(&state, &alice, true).await;
        let (bobs, _) = community(&state, &bob, true).await;

        assert_eq!(
            decision(&state, alices, &alice, false).await,
            MembershipDecision::Member
        );
        assert_eq!(
            decision(&state, bobs, &alice, false).await,
            MembershipDecision::Denied
        );
        assert_eq!(
            decision(&state, bobs, &bob, false).await,
            MembershipDecision::Member
        );
        assert_eq!(
            decision(&state, alices, &bob, false).await,
            MembershipDecision::Denied
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn the_server_wide_switch_still_closes_every_community() {
        let state = state(true).await;
        let (owner, stranger) = (Keys::generate(), Keys::generate());
        // The community's own setting says open; the server says closed, and the server wins.
        let (open_by_itself, _) = community(&state, &owner, false).await;
        assert_eq!(
            decision(&state, open_by_itself, &stranger, false).await,
            MembershipDecision::Denied
        );
        assert_eq!(
            decision(&state, open_by_itself, &owner, false).await,
            MembershipDecision::Member
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn closing_and_opening_a_community_takes_effect_at_once() {
        let state = state(false).await;
        let (owner, stranger) = (Keys::generate(), Keys::generate());
        let (id, _) = community(&state, &owner, false).await;
        assert_eq!(
            decision(&state, id, &stranger, false).await,
            MembershipDecision::OpenRelay
        );

        assert!(state
            .db
            .set_community_membership_required(id, true)
            .await
            .unwrap());
        state.forget_membership_policy(id);
        assert_eq!(
            decision(&state, id, &stranger, false).await,
            MembershipDecision::Denied
        );

        assert!(state
            .db
            .set_community_membership_required(id, false)
            .await
            .unwrap());
        state.forget_membership_policy(id);
        assert_eq!(
            decision(&state, id, &stranger, false).await,
            MembershipDecision::OpenRelay
        );
    }

    /// The final admission fence must not trust a remembered "open": a community closed by another server process is
    /// closed for it too, even before this process's cache has expired.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn the_authoritative_check_never_reads_a_stale_open_answer() {
        let state = state(false).await;
        let (owner, stranger) = (Keys::generate(), Keys::generate());
        let (id, _) = community(&state, &owner, false).await;
        // Remembered as open...
        assert_eq!(
            decision(&state, id, &stranger, false).await,
            MembershipDecision::OpenRelay
        );
        // ...then another process closes it (the cache here is not told).
        assert!(state
            .db
            .set_community_membership_required(id, true)
            .await
            .unwrap());
        assert_eq!(
            decision(&state, id, &stranger, true).await,
            MembershipDecision::Denied,
            "the authoritative check reads the database"
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn a_community_with_no_row_has_no_setting_of_its_own() {
        let state = state(false).await;
        let nobody = CommunityId::from_uuid(Uuid::new_v4());
        // Nothing to protect and nothing writable, so the community's own setting says "open"...
        assert!(!state
            .db
            .community_membership_required(nobody)
            .await
            .unwrap());
        assert!(!state
            .db
            .set_community_membership_required(nobody, true)
            .await
            .unwrap());
        // ...while the server-wide switch, when it is on, still closes it.
        let closed_server = super::postgres_tests::state(true).await;
        assert!(closed_server
            .membership_required(nobody, false)
            .await
            .unwrap());
    }

    /// The same through the HTTP bridge, with the community chosen by the Host header exactly as a browser's request
    /// is: a stranger is refused by the closed community and let through by the open one beside it.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn over_http_the_host_decides_which_policy_applies() {
        use axum::body::Body;
        use axum::http::{header, Request};
        use tower::ServiceExt;

        let state = state(false).await;
        let (owner, stranger) = (Keys::generate(), Keys::generate());
        let (_, closed_host) = community(&state, &owner, true).await;
        let (_, open_host) = community(&state, &owner, false).await;

        let query = |host: String, who: &Keys| {
            let state = state.clone();
            let pubkey = who.public_key().to_hex();
            async move {
                let response = crate::router::build_router(state)
                    .oneshot(
                        Request::builder()
                            .method("POST")
                            .uri("/query")
                            .header(header::HOST, host)
                            .header("x-pubkey", pubkey)
                            .header("content-type", "application/json")
                            .body(Body::from(r#"[{"kinds":[1],"limit":1}]"#))
                            .expect("request"),
                    )
                    .await
                    .expect("response");
                let status = response.status();
                let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
                    .await
                    .expect("body");
                (status, String::from_utf8_lossy(&body).to_string())
            }
        };

        let (status, body) = query(closed_host.clone(), &stranger).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert!(body.contains("relay_membership_required"), "{body}");
        assert_eq!(query(open_host, &stranger).await.0, StatusCode::OK);
        assert_eq!(query(closed_host, &owner).await.0, StatusCode::OK);
    }
}
