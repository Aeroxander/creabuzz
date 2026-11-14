# Copy pass 2: one name per thing

For the owner. Prepared 2026-11-10 from `git show` of the three commits of the pass, test files left out. Follows
[COPY-PASS-1.md](COPY-PASS-1.md) and the guide [PLAIN-WORDS.md](PLAIN-WORDS.md).

| Commit | Areas | Strings changed |
|---|---|---|
| `0f3ab97` | Home, chats, search | 24 |
| `32b299c` | boards, rooms, communities, Discover, moderation, invites | 42 |
| `5b3f255` | account, wiki, shared errors | 20 |
| | **Total** | **86** |

A later commit (the "Follow-up" one, section 5) restored one promise the pass had dropped, renamed leftovers of the old
words, and updated the tests and test steps that pinned old wording.

## 1. What this pass did and did not do

**It did.** It made each thing carry one name on every page (section 2), gave empty pages a sentence that says what
would appear there, and ended error messages with what to do next. It lower-cased nothing and capitalised three
labels that began in lower case (`Cancel`, `Cancel`, `Sign in to post`).

**It did not.** It changed no legal text: nothing under `docs/policies`, none of the join-policy files
(`web/src/features/identity/lib/join-policy.ts`, `policy-acceptance.ts`, `policy-links.ts`, `ui/PolicyBoxes.tsx`,
`ui/PolicyLinks.tsx`, `ui/PolicyReacceptHost.tsx`, `ui/use-join-policy.ts`, `web/src/features/invite/accept-policy.ts`,
`ui/InviteJoinPolicyNotice.tsx`) is in any of the three commits, and the one string changed on the invite page is the
download link's label. It changed no number and no logic, with two exceptions that are wording moved between a
component and its hook: the Reports panel no longer appends "Try refreshing." to every error (each error now carries
its own next step), and a room member who could not be added gets a sentence instead of "Failed to add member."

## 2. Naming decisions

| Use | Not | Where it applied |
|---|---|---|
| room | channel | community pages, room list, templates, AI helpers, code pages |
| chat (a private chat inside a community) | conversation, message | community private chats, the new-chat dialog, the room note "started this chat" |
| Messages (the private inbox on Home) | inbox | Home |
| Home | the feed, your timeline | back links, the Following tab |
| posts | the feed (as the thing that failed to load) | Home |
| bookmarks, to bookmark | saved posts, to save posts | Bookmarks |
| sign in | log in | desktop hand-off page |
| Reports | Moderation queue, report queue, the queue | community moderation |
| list of communities | community directory | Communities page |
| your community | your connected community | Communities page |
| topic | category | Discover |
| Loading… | Reading the server…, Reading this category… | Discover |
| AI helper | agent | room composer, community card, wiki. (The project help card says "Agent, run by …" on purpose; that is a label of record, not changed.) |
| team's members | seat holders | wiki |
| save (a wiki page) | publish to the server | wiki |
| your approval | the signature | passkey account |
| saved (a passkey, a list) | registered, written | account, bookmarks, mute list |
| try again | retry | account errors |
| The server did not accept … / did not answer … | Server rejected …, refused the queue | rooms, moderation, shared errors |
| Name | Display name | profile menu |

## 3. Changes by area

### Home (`0f3ab97`, 15 strings)

| Page | Before | After |
|---|---|---|
| Home, Following tab, empty | Your timeline is quiet | You don't follow anyone yet |
| Home, posts failed to load (title) | Couldn't load the feed | Couldn't load posts |
| Post page, back link | Back to the feed | Back to Home |
| Hashtag page, back link | Back to the feed | Back to Home |
| Hashtag page, empty (title) | Nothing for #(tag) yet | No posts with #(tag) yet |
| Explore, list failed to load | The server did not answer, so this list can't be shown. It is not known to be empty. | The server did not answer, so this list can't be shown. It may not be empty. |
| Notifications, empty (title) | Nothing yet | No notifications yet |
| Notifications, empty (text) | When someone interacts with you, you'll see it here. | Replies, votes, follows and mentions show up here. |
| Messages, empty (title) | Your inbox is empty | No messages yet |
| Message to a person, bad link (title) | Unknown recipient | We can't find this person |
| Bookmarks, signed out (title) | Sign in to save posts | Sign in to bookmark posts |
| Bookmarks, failed to load | The server did not answer, so your saved posts can't be shown. Nothing was lost. | The server did not answer, so your bookmarks can't be shown. Nothing was lost. |
| Bookmarks, partly loaded | Some of your saved posts couldn't be loaded, so this list may not be complete. Nothing was lost. | Some of your bookmarks couldn't be loaded, so this list may not be complete. Nothing was lost. |
| Bookmarks, list from another app | Your saved posts were written by another app in a form this one can't read, so nothing was changed. | Your bookmarks were saved by another app in a form this one can't read, so nothing was changed. |
| Mute, list from another app | Your mute list was written by another app in a form this one can't read, so nothing was changed. Change who you mute in that app instead. | Your mute list was saved by another app in a form this one can't read, so nothing was changed. Change who you mute in that app instead. |

### Chats (`0f3ab97`, 6 strings)

| Page | Before | After |
|---|---|---|
| Private chats, could not start | Couldn't start the conversation. Try again. | Couldn't start the chat. Try again. |
| Private chats, could not start, with the server's reason | Couldn't start the conversation. (reason) | Couldn't start the chat. (reason) |
| Private chats, list failed to load | The server didn't answer, so we can't tell whether you have any conversations. | The server didn't answer, so your conversations can't be shown. (Now "your chats" or "your notices", section 5.) |
| Private chats, nothing picked | Select a conversation to start reading. | Pick a chat to read it. |
| New chat dialog, backdrop (screen readers) | Close new message dialog | Close new chat dialog |
| New chat dialog, working | Starting the conversation… | Starting the chat… |

### Search (`0f3ab97`, 3 strings)

| Page | Before | After |
|---|---|---|
| Search inside a community, failed | The server did not answer the search. | The server did not answer, so there are no results to show. |
| Search on Home, posts failed | The server did not answer, so these results are not known to be empty. | The server did not answer, so there may be results we can't show. |
| Search on Home, people failed | The server did not answer, so these results are not known to be empty. | The server did not answer, so there may be results we can't show. |

### Boards (`32b299c`, 3 strings)

| Page | Before | After |
|---|---|---|
| Boards list, none found | No boards found among this server's newest rooms yet. There may be older ones. | No boards found yet. There may be older ones. |
| Board, empty | No posts yet. Start the first discussion. | No posts yet. Write the first one. |
| Board moderation, log empty | Nothing yet. | No actions yet. |

### Rooms (`32b299c`, 17 strings)

| Page | Before | After |
|---|---|---|
| Room list, lock on a private room (hover text) | Private room. A member with admin rights has to add you. | Private room. One of its admins has to add you. |
| Room, reaction refused (detail) | Server rejected the reaction | The server did not accept your reaction. Try again. |
| Room, reaction failed (title) | Couldn't add reaction | Couldn't add your reaction |
| Room, delete refused (detail) | Server rejected the deletion | The server did not delete the message. Try again. |
| Room, delete failed (title) | Couldn't delete message | Couldn't delete the message |
| Room, moderator removal failed (title) | Couldn't remove message | Couldn't remove the message |
| Room, messages failed to load | The server did not answer when asked for the messages in #(room), so we can't tell whether the room is empty. | The server did not answer, so the messages in #(room) can't be shown. |
| Composer, edit failed (title) | Couldn't edit message | Couldn't edit the message |
| Composer, send failed (title) | Couldn't send message | Couldn't send the message |
| Composer, upload failed (title) | Couldn't upload file | Couldn't upload the file |
| Composer, stop replying | cancel | Cancel |
| Composer, stop editing | cancel | Cancel |
| Composer, mention list, tag on a helper | agent | AI helper |
| Composer, signed out | sign in to post | Sign in to post |
| New room dialog, label of the open / private choice | Who can find it | Who can read it |
| New room, server said no without a reason | The server did not accept this write. Try again. | The server did not accept that. Try again. |
| New room, a person could not be added | Failed to add member. | Couldn't add them. Try again. |

### Communities (`32b299c`, 7 strings)

| Page | Before | After |
|---|---|---|
| Communities, adding a server you are on | This browser is already on that server. | You are already on that server. |
| Communities, list failed to load (title) | Couldn't load the community directory | Couldn't load the list of communities |
| Communities, list failed to load (text) | You can still open your connected community. Try again to browse other communities. | You can still open your community above. Try again to see the others. |
| Communities, server has no list | This server doesn't publish a public community directory. Open your connected community above to reach its chats. | This server doesn't list its communities. Open your community above to reach its rooms. |
| Communities, list request refused | Community directory unavailable (server responded (code)) | The list of communities is unavailable (server responded (code)) |
| Community card, archived | This community is archived, so its channels are no longer available. | This community is archived, so its rooms are no longer available. |
| Community card, no description | Browse this community in your browser. Join to see channels, messages, repositories, and agents. | Look around this community here. Join to see its rooms, messages, repositories and AI helpers. |

### Discover (`32b299c`, 6 strings)

| Page | Before | After |
|---|---|---|
| Discover, counting | Reading the server… | Loading… |
| Discover, failed to load (title) | Couldn't read this server | Couldn't load this page |
| Discover, failed to load (text) | The server didn't answer the directory request. We're not showing an empty list, because that would wrongly suggest there's nothing here. | The server didn't answer, so we can't show what is here. |
| Discover, no projects | No projects on this server yet. Start one. Add a pitch and the roles you need, and it appears here for everyone reading this page. | No projects on this server yet. Start one: add a pitch and the roles you need, and it shows up here. (Now ends "shows up here for everyone.", section 4.) |
| Discover, topic loading | Reading this category… | Loading this topic… |
| Discover, topic failed | The server did not answer this category's page. | The server did not answer, so this topic can't be shown. |

### Moderation (`32b299c`, 6 strings)

| Page | Before | After |
|---|---|---|
| Moderation, panel heading | Moderation queue | Reports |
| Moderation, checking stopped | Auto-refresh paused | Stopped checking for new reports |
| Moderation, error line | (error) Try refreshing. | (error) |
| Moderation, reports failed to load | Couldn't load the report queue. Check your connection, then refresh. | Couldn't load the reports. Check your connection, then refresh. |
| Moderation, server said no (detail) | The server refused the queue ((code)). | The server did not send the reports ((code)). |
| Moderation, reports passed up to you, none | Nothing waiting on you. | No reports are waiting for you. |

### Invites (`32b299c`, 3 strings)

| Page | Before | After |
|---|---|---|
| Invite, no uses left | This invite has reached its use limit. Ask for a new invite. | This invite has been used up. Ask for a new invite. |
| Invite, not a real invite | This invite is invalid. Check the link or ask for a new invite. | This invite link doesn't work. Check the link, or ask for a new invite. |
| Invite, desktop download link (builds that offer the desktop app) | Download it now | Download the app |

### Account (`5b3f255`, 11 strings)

| Page | Before | After |
|---|---|---|
| Linking a passkey account, refused | Your passkey account did not accept the signature, so nothing was published. Try again, or sign in with your passkey first. | Your passkey account did not accept your approval, so nothing was published. Try again, or sign in with your passkey first. |
| Passkey account unavailable: no passkey (reason) | No passkey is registered in this browser. | No passkey is saved in this browser. |
| Passkey account unavailable: no passkey (what to do) | Open your profile menu, choose "Set up passkey sign-in", then retry. | Open your profile menu, choose "Set up passkey sign-in", then try again. |
| Passkey account unavailable: old passkey (reason) | This browser's passkey has no wallet owner key yet (it predates wallet-owner capture). | This browser's passkey is an older kind that cannot approve payments yet. |
| Passkey account unavailable: site not set up (reason) | The sponsored stack is not configured (VITE_ZERODEV_CHAIN_ID and a chain RPC URL are required). | Passkey accounts are not set up on this site's network yet. |
| Passkey account unavailable: site not set up (what to do) | Set the ZeroDev chain id and chain RPC URL, then reload. | Ask whoever runs this site to finish the setup, then reload. |
| Saved account can't be read, button after the recovery key | Import | Use this key |
| Desktop hand-off, question | Log in to desktop as @(name)? | Sign in to the desktop app as @(name)? |
| Desktop hand-off, with a passkey | One passkey check logs this desktop in. Nothing is shared until you confirm here. | One passkey check signs the desktop app in. Nothing is shared until you confirm here. |
| Desktop hand-off, button | Log in desktop | Sign in on desktop |
| Profile menu, name box (placeholder) | Display name | Name |

### Wiki (`5b3f255`, 6 strings)

| Page | Before | After |
|---|---|---|
| Wiki, live editing off: signed out | Live co-editing is unavailable: you need to be signed in with an account so the page can tell you are a community member. Edits reach others when a page is saved. | Live co-editing is unavailable: sign in so the page can tell you are a community member. Edits reach others when a page is saved. |
| Wiki, live editing off: could not start | Live co-editing is unavailable: the shared editing session could not be started. Reopen the page to try again. Edits reach others when a page is saved. | Live co-editing is unavailable: it could not be started. Reopen the page to try again. Edits reach others when a page is saved. |
| Wiki, suggest a correction | This page is kept up to date by an agent, so it can't be edited here. Describe the correction and it'll be reviewed and folded into a later update. | An AI helper keeps this page up to date, so it can't be edited here. Describe the correction; it is reviewed and added in a later update. |
| Wiki, Save button (hover text, changes waiting) | Publish this page to the server | Save this page for everyone |
| Wiki, Save button (hover text, nothing to save) | No unpublished changes | No unsaved changes |
| Wiki, page a team owns | Only this team's seat holders can edit this page. You can read it and propose a change. | Only this team's members can edit this page. You can read it and propose a change. |

### Shared errors (`5b3f255`, 3 strings)

| Page | Before | After |
|---|---|---|
| Any page, server refused a read | The server refused this request. Its own message is under Technical details. We're not showing an empty list, because that would wrongly suggest nothing is here. | The server refused this request, so we can't show what is here. Its own message is under Technical details. |
| Any page, sign-in needed | This server requires sign-in to load. Sign in with your passkey below and this page will retry automatically. | Sign in to see this. Use your passkey below and the page loads by itself. |
| Any page, no answer (hint) | The server may be offline or unreachable from this browser. | The server may be offline, or this browser can't reach it. |

## 4. Check: did any sentence change what it claims

Each pair above was read against the code around it.

**One fixed.**

- Discover, no projects. The old sentence told the writer the pitch "appears here for everyone reading this page"; the
  pass cut that to "shows up here". That is the line that says a pitch is public, so it now ends "shows up here for
  everyone."

**Read closely and kept.**

- "Who can find it" became "Who can read it" (new room). The choice is open or private, and a private room still
  shows in the room list with a lock, so "read" is what the control decides. The edit-room dialog already said it.
- "Your timeline is quiet" became "You don't follow anyone yet". The empty state is shown only when the follow list
  is empty, so the new title is true.
- Notifications' empty text now names replies, votes, follows and mentions. All four are read by that page (so are
  reposts, quotes and moderators' notices, which it does not name).
- Moderation dropped "Try refreshing." after every error. The two errors that reach that line are "Only community
  moderators can review reports." (refreshing does not help) and "Couldn't load the reports. Check your connection,
  then refresh." (already says it).
- "seat holders" became "members" of the team. The rule is unchanged: people who hold a seat in that team, and
  community admins.
- "an older kind that cannot approve payments yet" replaces "has no wallet owner key yet". It is the same condition
  said by its effect.
- "Save this page for everyone" replaces "Publish this page to the server" (hover text). Saving is what sends a wiki
  page to others; "everyone" here means everyone who can read the wiki.

## 5. Follow-up: leftovers and pinned wording

**Old words still on screen, renamed.**

| Page | Before | After |
|---|---|---|
| Private chats, list failed (title) | Couldn't load conversations | Couldn't load chats (a build with only notices: Couldn't load notices) |
| Private chats, list failed (text) | The server didn't answer, so your conversations can't be shown. | The server didn't answer, so your chats can't be shown. (or: your notices) |
| Private chats, loading | Loading conversations… | Loading chats… (or: Loading notices…) |
| Private chats, back on a phone | All conversations | All chats (or: All notices) |
| Room note in a private chat | (name) started this conversation | (name) started this chat |
| Profile page, back link (two places, screen readers) | Back to the feed | Back to Home |
| Discover, topic picker in a build with sales (screen readers) | Browse launches by category / Launch categories | Browse launches by topic / Launch topics |
| Discover, filter row (screen readers) | Filter the directory | Filter what is shown |
| Discover, loading | Loading the directory… | Loading… |
| Community card, rooms failed to load | (host) did not answer the channel query. | (host) did not answer, so its rooms can't be shown. |
| Project discussion, board opened | …the project no longer lists one of the channels you picked. | …the project no longer lists one of the rooms you picked. |
| Starting from a template, not allowed | You can't create channels here yet. Ask this community's owner to add you. | You can't create rooms here yet. Ask this community's owner to add you. |
| Starting from a template, preview | Channels that already exist here are reused. / Channels and boards | Rooms that already exist here are reused. / Rooms and boards |
| Starting from a template, done | …a welcome message in #the first channel. | …a welcome message in #the first room. |
| AI helpers page | Mention @(name) in a channel to get an answer. (two places) | Mention @(name) in a room to get an answer. |
| Work board, new task | No channel | No room |
| Org setup, done | Invite people to a channel, or … | Invite people to a room, or … |
| Code page | View channel | View room |

**Left as they are, on purpose.**

- "Auto-refresh paused" on the workflow runs list: a different list from Reports, outside this pass.
- "Posted by an agent on its owner's behalf" on a post, and "Agent, run by …" on a help card: labels of record.
- "Couldn't load this conversation" and "Open the conversation: …" on Home: these are message threads on Home, not
  community chats.
- Budget pages still say "agent". They were outside this pass; renaming them to "AI helper" is a separate change.
- Nothing under `web/src/features/launchpad` or `web/src/features/start` was read for leftovers or edited.

**Tests and test steps that pinned old wording, updated.** `web/tests/e2e-real/invite-only.spec.ts` ("use limit"),
`web/tests/e2e/start-project.spec.ts`, `web/src/features/channels/lib/system-notes.test.mjs`,
`web/src/features/templates/lib/explain.test.mjs`, `run-plan.test.mjs`, `web/src/shared/lib/readable-error.test.mjs`,
and six lines of [TEST-STEPS.md](TEST-STEPS.md) that called the Reports list "the moderation queue". Nothing in
`scripts/` or [PILOT-RUNBOOK.md](PILOT-RUNBOOK.md) carried old wording.

## 6. Checks run

At commit `cc71168` (2026-11-10), in `web/`: `pnpm typecheck`, `pnpm check` (which includes `check:copy`) and
`pnpm test` (3,008 unit tests: 3,007 pass, 1 skipped) all pass. The whole Playwright `smoke` project, on a private
build and port: 714 tests, 673 passed, 41 skipped, none failed. The skipped ones need a local chain or a build switch
and skip themselves. `web/tests/e2e-real` (a real server) was not run; its one changed pin was updated by text.
