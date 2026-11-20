//! The people who keep a project's room remove posts from it with the existing kind 9005 request, and nobody else
//! is given more than they had: a team member never removes the founder's post or another member's, nobody removes a
//! server operator's, a like is not a post and a post outside any room is a community moderator's alone. The removal,
//! its audit row and its public log entry are the existing transaction. Ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib -- room_removal_postgres_tests --include-ignored --test-threads=1`.

use nostr::{Event, Keys};

use super::home_moderation::{
    KEEPER_GUARD_RAIL, NOT_A_KEEPER, NOT_A_MODERATOR, OPERATOR_GUARD_RAIL,
};
use super::room_support::{ingest, room_world_with, signed, tag, RoomWorld};

const HOLDER: usize = 3;
const OTHER_HOLDER: usize = 4;

fn removal(who: &Keys, target: &Event, reason: Option<&str>) -> Event {
    let mut tags = vec![tag(&["e", &target.id.to_hex()])];
    if let Some(reason) = reason {
        tags.push(tag(&["public_reason", reason]));
    }
    signed(who, 9005, &tags, "", 0)
}

async fn is_stored(w: &RoomWorld, event: &Event) -> bool {
    w.state
        .db
        .get_event_by_id(w.tenant.community(), &event.id.to_bytes())
        .await
        .expect("a read")
        .is_some()
}

async fn accept(w: &RoomWorld, event: Event, what: &str) {
    if let Err(reason) = ingest(&w.state, &w.tenant, event).await {
        panic!("{what}: refused: {reason}");
    }
}

async fn refuse(w: &RoomWorld, event: Event, expected: &str, what: &str) {
    match ingest(&w.state, &w.tenant, event).await {
        Ok(()) => panic!("{what}: should be refused"),
        Err(reason) => assert!(
            reason.contains(expected),
            "{what}: refused for the wrong reason: {reason}"
        ),
    }
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn r19_and_r20_the_team_removes_posts_in_its_own_room_with_a_public_reason_and_a_log_entry() {
    let operator = Keys::generate();
    let operator_hex = operator.public_key().to_hex();
    let w = room_world_with(true, move |c| c.relay_operator_pubkeys = vec![operator_hex]).await;
    w.seed_to(w.fx.head()).await;
    super::room_support::add_member(&w.state, &w.tenant, &operator).await;
    let holder = w.account().await;
    w.link(&holder, HOLDER, 3_600).await.expect("link");
    let teammate = w.mate.clone();
    w.link(&teammate, OTHER_HOLDER, 3_600).await.expect("link");
    w.link(&w.founder, HOLDER, 3_600).await.expect("link");
    w.link(&operator, HOLDER, 3_600).await.expect("link");

    // The founder removes a holder's post, with a reason, and the public log names the author.
    let post = w.post(&holder, "a post the team will remove");
    accept(&w, post.clone(), "a holder's post").await;
    accept(
        &w,
        removal(&w.founder, &post, Some("Off topic")),
        "the founder's removal",
    )
    .await;
    assert!(
        !is_stored(&w, &post).await,
        "the post is gone from every read"
    );
    let logs = w
        .state
        .db
        .query_events(&buzz_db::EventQuery {
            kinds: Some(vec![45004]),
            p_tag_hex: Some(holder.public_key().to_hex()),
            limit: Some(10),
            ..buzz_db::EventQuery::for_community(w.tenant.community())
        })
        .await
        .expect("the public log");
    assert_eq!(logs.len(), 1, "one public log entry names the author");
    let entry = &logs[0].event;
    let value = |name: &str| {
        entry.tags.iter().find_map(|t| {
            let parts = t.as_slice();
            (parts.first().map(String::as_str) == Some(name)).then(|| parts[1].clone())
        })
    };
    assert_eq!(value("role").as_deref(), Some("project_team"));
    assert_eq!(value("actor"), Some(w.founder.public_key().to_hex()));
    assert_eq!(value("e"), Some(post.id.to_hex()));
    assert_eq!(entry.content, "Off topic");
    // The audit row says who and under which authority.
    let authority: String = sqlx::query_scalar(
        "SELECT actor_authority FROM moderation_actions WHERE community_id = $1 AND target_event_id = $2",
    )
    .bind(w.tenant.community().as_uuid())
    .bind(post.id.to_bytes().as_slice())
    .fetch_one(w.state.db.pool())
    .await
    .expect("the audit row");
    assert_eq!(authority, "board_moderator");

    // A team member removes a holder's post, not the founder's or another member's, and not a stranger's request.
    let again = w.post(&holder, "another post");
    accept(&w, again.clone(), "a holder's post").await;
    let stranger = w.account().await;
    refuse(
        &w,
        removal(&stranger, &again, None),
        NOT_A_KEEPER,
        "a stranger's removal",
    )
    .await;
    let founders = w.post(&w.founder, "the founder's post");
    accept(&w, founders.clone(), "the founder's post").await;
    refuse(
        &w,
        removal(&teammate, &founders, None),
        KEEPER_GUARD_RAIL,
        "a member removes the founder's post",
    )
    .await;
    let members = w.post(&teammate, "a member's post");
    accept(&w, members.clone(), "a member's post").await;
    let other_member = w.account().await;
    refuse(
        &w,
        removal(&other_member, &members, None),
        NOT_A_KEEPER,
        "a stranger removes a member's post",
    )
    .await;
    accept(
        &w,
        removal(&teammate, &again, None),
        "a member removes a holder's post",
    )
    .await;
    assert!(!is_stored(&w, &again).await);
    // Only the founder removes a team member's post.
    accept(
        &w,
        removal(&w.founder, &members, None),
        "the founder removes a member's post",
    )
    .await;
    assert!(!is_stored(&w, &members).await);

    // Another project's team has no say in this room.
    let other_founder = w.account().await;
    w.extra_project(&other_founder, "elsewhere").await;
    let third = w.post(&holder, "a third post");
    accept(&w, third.clone(), "a holder's post").await;
    refuse(
        &w,
        removal(&other_founder, &third, None),
        NOT_A_KEEPER,
        "another project's founder",
    )
    .await;

    // Nobody removes a server operator's post from a room.
    let operators = w.post(&operator, "the operator's post");
    accept(&w, operators.clone(), "an operator's post").await;
    refuse(
        &w,
        removal(&teammate, &operators, None),
        OPERATOR_GUARD_RAIL,
        "a member removes an operator's post",
    )
    .await;
    refuse(
        &w,
        removal(&w.founder, &operators, None),
        OPERATOR_GUARD_RAIL,
        "the founder removes an operator's post",
    )
    .await;

    // A like is not a post.
    let like = w.like(&holder, &third);
    accept(&w, like.clone(), "a like").await;
    refuse(
        &w,
        removal(&w.founder, &like, None),
        "only posts and replies",
        "a like",
    )
    .await;

    // A post that is in no room is for the community's moderators alone.
    let plain = signed(&holder, 1, &[], "an ordinary post", 0);
    accept(&w, plain.clone(), "an ordinary post").await;
    refuse(
        &w,
        removal(&w.founder, &plain, None),
        NOT_A_MODERATOR,
        "an ordinary post is not the team's",
    )
    .await;
}
