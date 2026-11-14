# Creaton web app: what the browser test review found

This is a reading review of every spec in the mocked browser suite. Alongside it, the full mocked suite was run on 2026-11-01: 562 passed, 36 skipped (the skipped ones need a real local chain). It combines the verified findings from every feature area. Findings marked *confirmed* or *adjusted* were checked against the code. Most copy findings were **not** checked by the verifier, apart from a few high-impact ones that I mark as checked. Treat the unchecked copy suggestions as proposals.

---

## 1. The short version

- **The mocked suite tests a different build from the one the pilot ships.** Every mocked spec runs the default build, which offers raises. The contributor-only pilot build (`VITE_CONTRIBUTOR_ONLY=1`) gets almost no mocked browser coverage. Discover, Start, "Your work", the Ideas list, the Notices panel, the Tasks board as pilot users see it, and phone/axe checks of contributor project pages are all untested there. Meanwhile about 45 tests guard sale, bid and helper screens the pilot hides (`playwright.config.ts:25-97`).
- **A green mocked run does not mean the core loop works.** About thirteen chain-backed specs sit in the `smoke` project and `test.skip` without `E2E_ANVIL_URL`. In a mocked run they show as skipped. No mocked test submits work, accepts it, approves it, settles it, marks it finished or votes on a decision. The newest working-cycle features (Now, take-on, check note, challenge, New here, AI helpers) appear in only one opt-in chain spec.
- **Three things break people's trust or privacy.** The mute list is public, so the person you muted can see it. The "Also share with other apps" box is sticky: once ticked, it copies all later votes and replies to public servers for good. The ban form promises "They are told the reason you give", but a banned person can never read it. "Escalate" also promises a hand-off that nobody receives in the pilot.
- **People can lose their account.** "Remove passkey sign-in" deletes a passkey-only account in one click with no warning. The unlock overlay re-prompts in a loop and has no way out. A single Copy of the recovery key counts as "saved". The invite page, which is how every pilot user arrives, makes the no-passkey account the main button, and that account can't be paid.
- **Raise-era and AI features leak into the pilot.** Community setup still writes six AI helpers, their seats and a helper limit, and shows "6 AI helpers". `$TICKER` chips show token prices. A funding sale of new units is gated only by a contract address. The community Tasks board offers points claims that no screen in the web app can ever accept. "Workflow runs" sits in every bell.
- **The contributor loop asks too much.** Earning Shares takes about ten actions by four people, including a "Finish the review" press and, 7 days later, a "Mark it finished" press that moves nothing but blocks the award. "Finish" means two different steps. One idea has five names ("Done when", "the words", "How it should be judged", "acceptance check", "What finished work looks like").
- **The copy keeps sounding like the protocol.** The same screen says "channel" and "room". "Mute" means two opposite things. "Project" means three things. "Tokens" and "Shares" are used for the same holding. Errors follow the pattern "The server did not X, so Y". Internals reach the main copy: `nostr:npub1…` in the post box, `image/gif`, `floorPrice`, hex claim ids, chain-id numbers, "contributor kit", "restricted:".
- **Several tests can never fail.** Examples: a `.catch(() => undefined)` around an assertion whose expected order is wrong (`board.spec.ts:1208`), a swallowed check in `chat-removal.spec.ts:175`, a bounty "dip resets the clock" test that passes with or without the reset, and a "Reconnecting|Connecting" regex that passes before any drop. Some tests also lock in wrong behaviour, such as `ws://` on https, a crash on a malformed directory, and a retry button on an expired invite.

---

## 2. Remove or hide for the MVP

Only items the verifier confirmed or adjusted. "Cost" means what is lost or what it takes.

| What | Why | What depends on it | Cost |
|---|---|---|---|
| **"Also share with other apps" checkbox** (`PostComposer.tsx:521`, mirror in `use-feed.ts:285`, `mirror.ts`) | The setting is saved for good (`buzz.feed.mirror`) and then copies kinds 1, 1111, 6 and 7 (posts, replies, reposts, up/down votes) to relay.damus.io and nos.lol, including on invite-only servers. *Confirmed.* | Only `feed.spec.ts:414`. | Hide it in the contributor-only build and on invite-only servers. If it stays elsewhere, make it apply to one post only, with no saved setting and never for votes. Add a "vote doesn't mirror" spec. |
| **"Escalate" in the moderation queue** (`ModerationQueuePanel.tsx:204`) | It says "Passed on to the people who run this server", but in the pilot only the desktop admin console (out of scope) reads escalated reports. The operator API exists (`api/admin/mod.rs:216`), but nothing in the pilot uses it. *Adjusted.* | The Escalated filter and its spec. | Either hide it in the contributor-only build, or add `buzz-admin reports --escalated` plus a runbook line. Until then, change the line to "Marked for the server's owner. Nobody has picked it up yet." |
| **Helper steps in community setup** (`packages/creaton-core/src/templates/apply.ts:175`, `use-template-apply.ts:165`) | Pilot servers get personas (30175), helper seats (37010), a helper limit (37012), automations and skills, and the done screen lists them. *Confirmed.* | `start-project.spec.ts` asserts these counts, but only on the default build, so those assertions stay valid. | Add a contributor-only filter to `planApply` and a unit test proving the plan has no 30175/37012 steps. Also drop "6 AI helpers" from `templateCounts` and the preset blurbs. |
| **Points reward and "Claim as contribution" on the community Tasks board** (`TaskPlanningPanel.tsx:128-204`) | In the web app nothing ever sets `reviewStatus: "accepted"`; only `buzz-cli agent_wiki.rs:898` does. So pilot claims stay pending forever, beside the real Shares path. The help text also says points "add to the contributor's share", which contradicts Portfolio. *Confirmed.* | The Points card already hides for people without points (DEPRECATION #7). | Hide Reward, the points note and Claim in the pilot. Keep Tasks as plain to-dos (owner, due date, Next up), or link a task to a work area. |
| **Funding round / "Funding the project" card** (`DecisionComposer.tsx:223-229`, `FundingCard.tsx:32`) | Selling new units to buyers is a raise, but it is gated only on the weekly-rounds contract address, not on `raisesOffered()`. "Trading" right above it is already gated. *Confirmed.* | Nothing in the pilot. | Two lines of code. Raise builds are unchanged. |
| **"Use my wallet instead" sign-up** (`OnboardingDialog.tsx:403-415`) | It shows whenever `window.ethereum` exists, needs no name, and creates an account that can't be paid in the pilot. *Confirmed.* | Nothing in the pilot. | Gate it on `raisesOffered()`. |
| **"Open in Creaton" desktop link on the community page** (`CommunityHomePage.tsx:313`) | It is a desktop deep link with no `DESKTOP_APP` gate, and there is no desktop app in the MVP. *Confirmed.* | Nothing. | Wrap it in `DESKTOP_APP ? … : null`, as `InvitePage` does. |
| **"Community scores" card, and the trust gate's root list** (`OverviewTab.tsx:468` ScoreRootsCard, `TrustGateCard.tsx:46`) | Any member can publish kind 37006 (`fetchScoreRoots`, `use-launches.ts:167`, has no author filter). The card then shows a "View proofs and scores" link to their own URL on every project page, contributor projects included. That is a ready-made phishing link. *Confirmed.* | The "community data plane" test. | Remove ScoreRootsCard. Either limit TrustGateCard to roots signed by the operator or hide it in the pilot. |
| **Inline profile editor in the account menu** (`ProfileMenu.tsx:449-498`, `saveProfile` 238-263) | A second editor next to `EditProfileDialog`, with its own save path and errors. It is cramped on phones and has broken before. *Confirmed.* | The account-menu upload spec. | Have "Edit profile" open the dialog, then delete the inline form and its spec. |
| **`$TICKER` price chips in the contributor-only build** (`use-cashtags.ts:10`) | They resolve against every launch with no `listedHere` filter, so a no-money Home can show "open for backers… 0.5000 ETH per token". *Confirmed, medium confidence* (it needs a raise published by another build). | `social-cashtag.spec.ts`. | Filter with `listedHere(record, raisesOffered())` and drop the price words when raises are off. |
| **"Workflow runs" in the notifications bell** (`NotificationBell.tsx:108-121`) | It always shows, and is usually empty. *Adjusted:* templates do create workflow definitions (`apply.ts:475-487`), so don't gate by build. | `polling-bounds.spec.ts`. | Show it only when the community has a 30620 definition or a recent run, the way `ApprovalsPanel` hides itself. Seed one definition in the polling spec. |
| **Tasks board "Assignee" (helpers only) and the Issues filter in the pilot** (`WorkBoard.tsx:402-447`) | With no helpers, Assignee only ever shows "Anyone". Issues come from hidden repositories. *Confirmed.* | None. | Fill Assignee from people (`useMentionCandidates`) or hide it when empty. Hide Issues and say "3 tasks" in the pilot. |
| **One-time launch-follow migration** (`use-launch-follows.ts:15` LEGACY_KEY) | No pilot browser has the old key. *Confirmed, low.* | Its own test in `feed.spec.ts`. | Remove the code and the test together. Keep the bookmark-follow test, but drive it from a Discover card. |
| **`/identity-demo` prototype and its tests** (`passkey.spec.ts:50-138`) | The hosted build never serves it, and its Remove and unlock code differ from production. *Confirmed.* | `UserOpDemoCard` is also imported by `lib/sponsoredSender.ts`; check that import before deleting. | Move the storage-posture assertion into a production passkey spec, then delete the demo specs (and possibly the route). |
| **Long mutes that need a second moderator** (`MuteDialog.tsx:82`) | *Adjusted:* the copy is honest, but in a few-person pilot the confirm-within-a-day flow is extra to learn and will rarely be met. | `board-moderation.test.mjs:287`, the `board-mute-second-*` spec. | Filter `needsSecond` choices out of the dialog only, keeping server and log handling. This is the owner's call (see section 8). |

**Not recommended for removal**, though the reviewers raised them:
- **Projects board.** DEPRECATION #4 already gated it, and it feeds Start-from-pitch.
- **Post bounties.** The court and forecasts are shared with work areas, and the bounty contract is already off in the pilot image.
- **Fleet, repos and sale-wizard smoke tests.** Raise builds are still the default build, so these guard live code.
- **The "receive from other apps" banner.** It is already hidden on invite-only servers.
- **The leave/ragequit panel.** Contributor DAOs can hold money. Collapse it when it pays nothing instead of removing it.
- **The panel milestone mode.** Removing it needs a pre-audit decision, because it is in `AUDIT-SCOPE.md`.

---

## 3. Features to improve

### Account safety and recovery (highest priority)
- **Confirm before "Remove passkey sign-in"** (`ProfileMenu.tsx:660-667` → `passkey-identity.ts:334`). Use the Sign out ConfirmDialog. When a PRF account has `!hasBackedUp()`, show "You haven't saved your recovery key. Without it this account is gone for good." with "Save recovery key" as the main button and "Remove anyway" as the second. Or drop the item for PRF accounts.
- **Fix the unlock overlay** (`PasskeyUnlockGate.tsx:46-51`). `unlock` is a new closure on every render, so the effect re-fires and starts ceremony after ceremony. Run the auto-prompt once with a `useRef` guard. Add a "Sign out" link, plus "Sign in with my recovery key instead" as a second option.
- **Only count the key as saved when it really is** (`RecoveryKeyDialog.tsx:92-94`, `ProfileMenu.tsx:640-645`). After Copy, ask for a tick: "I've pasted it somewhere safe". Download keeps counting on its own.
- **Put recovery in Get started** (`home-steps.ts:59-98`). Add "Save your recovery key" when `!hasBackedUp()`. In the pilot, add "Set up passkey sign-in" for accounts without a passkey ("You need it to be paid for work").
- **Make the invite page match the sign-up dialog** (`InvitePage.tsx:500-558`). Make "Create with a passkey" the main button. Turn "Create without a passkey" into a quiet link that says it can't be paid. Require a name. Add "Already have an account? Sign in with your recovery key" and return to the invite afterwards (`:465-500`).
- **Invite-only sign-up** (`InviteOnlySignUpNotice.tsx`). Lead with "Paste your invite link". Keep "I already have an account". Shrink account creation to a quiet "Make an account anyway" link.
- **Later, for new registrations only:** put the PRF salt in the passkey's `user.id` (`passkey.ts:616`), so synced passkeys work on other devices. Existing accounts keep their stored salt.

### Joining a community
- **Use the right scheme** (`relay-url.ts:36`). A bare host becomes `ws://` even on https, gets saved, and leaves the person stuck on every reload. Use `wss://` when the page is https.
- **No retry on a dead invite** (`InvitePage.tsx:465-498`, `invite-errors.ts`). For invite_expired, exhausted or invalid, hide Join, say "Ask whoever sent it for a new link", and add a "Go to Creaton" link.
- **Create community field** (`CreateCommunityDialog.tsx:94-120`). It is labelled "What is it called?" but rewrites the input into an address as you type. Label it "Pick its web address" and show "It will live at {name}.{domain}".
- **Hide setup from people who can't do it.** The empty-community "Set up community" button shows to everyone (`CommunityShell.tsx:810`). Gate it on `offersSetup`. Do the same for the org wizard (`OrgView.tsx:322`, via `useCommunitySetupAccess`, still showing it when access is "unknown" or "error").
- **Archived community** (`CommunityHomePage.tsx:215`). Show a plain notice with no "Try again" and no sign-in recovery.
- **Malformed directory** (`use-communities.ts:38`). Validate the shape so the existing directory-error panel shows instead of crashing the page.

### The contributor loop
- **Let the deciding vote finish the review.** When an approval reaches quorum, send attest and settle together through `onSendBatch`. If the batch fails, send the attest alone (`WorkTab.tsx:851`, `ClaimStake.settle` has no time condition).
- **Make "Mark it finished" visible** (`work.ts:666-681`, `decision-forms.tsx:405-413`). Put the date in the Approved line. Add the step to the contributor's Needs you once the wait is over. In the award form, list claims "waiting for {name} to mark it finished" instead of saying "No approved work is waiting". Letting anyone call payout on zero-amount claims needs a contract change; that goes to the audit backlog.
- **Award link opens the award** (`WorkTab.tsx:954`). Pass an AwardIntent, like ChallengeIntent, so it opens "Award Shares" with this claim chosen.
- **Check the ask against the work area's money** (`FileClaimCard.tsx:283`). Today an ask above `budget − reserved` is filed, but no manager is ever offered "Accept for review". *Bug, confirmed.*
- **Read-only "Done when"** (`FileClaimCard.tsx:560`). When the area's words are published, show them as read-only text and drop "Use different words", which can only produce a refused claim. Keep the typed box when the words aren't published or there are no areas.
- **Turn-downs should teach something** (`ReviewActions.tsx:151`). Require "What was missing?" when the reviewer's account is linked. Keep the no-reason path for unlinked accounts and publish failures.
- **Challenge, unlinked account** (`DecisionComposer.tsx:283`). Link inline (AccountNameLink for passkey accounts). Keep "Open the vote without the answers" as the smaller option.
- **Check note** (`CheckNoteCard.tsx:285-289`). Don't show a red `role=alert` before the founder has typed anything. Gate it on `tried`, as TakeOnWork does.
- **Interview** (`TakeOnInterview.tsx:96-128`). Make the last question's button "Draft it for me" and add Back.
- **New here step 3** (`NewHereCard.tsx:116`). Make it something the person can do: "Submit what you took on for review…".
- **Start form** (`ContributorStartPage.tsx:425`). Put the Shares code, the three Share numbers and the quorum under "Change the numbers", and open it automatically when a warning points inside.
- **AI self-check** (`WorkCheckAi.tsx:25-45`). Clear gaps when the inputs change, and ignore replies to inputs that have since changed.

### Moderation that feels fair
- **Ban** (`BanPanel.tsx:35`). Preselect no length, and order the choices 1 day / 7 days / 30 days / For good. Use the same BanForm (length plus reason) in the queue (`ModerationQueuePanel.tsx:272-284`).
- **Queue actions** (`use-moderation-queue.ts:332-354`). If the ban worked but closing the report failed, say so: "Carol Ng is banned, but the report couldn't be closed. Close it with Dismiss."
- **Reasons and confirmations.** Room message removal should ask for a reason like boards do (`ChannelTimeline.tsx:970-985`). Appointing a moderator by pasted link should go through the same named confirm (`BoardModerationPanel.tsx:158-166`). "Step down" should confirm (`:231`).
- **One button for gone words.** For reports about words already gone, offer one "Close (it's already gone)" button instead of Close plus Dismiss (`board-reports.ts:115`).
- **Notices name the board** ("…your reply in #ideas"). Name the moderation-notice sender after the community, not the hostname (`moderation_notices.rs:235`).
- **Muting.** Store mutes privately with NIP-44, reading old public tags so existing mutes keep working (`use-social-actions.ts:43-111`). Give the button a name ("Mute {name}"). The toast says what muting does. The inbox lists hidden conversations by name with a "Show" button (`MessagesPage.tsx:196-206`).
- **Roles.** "Make admin": add a toast saying what an admin can do, with Undo. Rename the reverse to "Remove admin" (`PeopleSection.tsx:400-411`).

### Writing posts
- **Mentions** (`PostComposer.tsx:216`). Show "@Alice Archer" in the box and turn it into `nostr:npub…` only on publish, following the repo's mention contract (exact key per label, ambiguous typed names fail visibly). Count the label, not the URI, toward the limit.
- **Pictures** (`PostComposer.tsx:186-200`). In short posts, show thumbnails with a remove button. On boards, keep the inline Markdown and show a preview.
- **Placeholder.** "What's happening?" becomes "Share an update or ask a question".
- **Edits.** Mark edited messages with "(edited)" (`ChannelTimeline.tsx:262`).
- **Wiki** (`PageDialog.tsx:62`). Keep the typed title for display and use the slug only in the address.

### Error states
- **Say refusal, not silence.** Pass `error` to QueryError on the Tasks, fleet ×2 and search panels (`WorkBoard.tsx:343`, `FleetView.tsx:234/367`, `SearchResults.tsx:121`). Today they claim the server "did not answer" when it refused.
- **Bad numbers.** Reward and Credit should reject "fifty" or "50.5" inline instead of quietly making an unrewarded task (`BoardIdeas.tsx:104`).
- **Failed saves.** For IP and pledge saves, map the error to one plain sentence in one place (`use-launches.ts`) and keep the draft.
- **Account prompts.** "Create your account (top right)" is wrong on phones, where the menu is in the bottom bar. Give the toast a "Create your account" action instead (`account-copy.ts:17`).

### Show the real state instead of "click, then fail"
- **Board ideas** (`BoardIdeas.tsx:269`) and **task planning** (`TaskPlanningPanel.tsx:83`). On load, read the existing 37013 record and show "Claimed, waiting for a reviewer" instead of a Claim button that errors.

### Accessibility
- **Mention list keyboard support** (`Composer.tsx:258`). Arrow keys, Enter/Tab to pick, Escape to close, and listbox roles. Today Enter sends "@Ali" with no mention.
- **Sign-out confirm** (`ProfileMenu.tsx:782`). Make it a real alertdialog with focus moved into it and Escape to close.
- **Bell** (`NotificationBell.tsx:92`). Use `aria-label="Notifications, N unread"` and add `aria-expanded`.
- **Get started** (`HomeHero.tsx:241`). Add hidden "Done:" / "To do:" text and name each "Go" after its step.
- **Replies.** Give reply rows an accessible marker, and change "Replying to a message" to "Replying to Alice".
- **Search shortcut.** Show "Ctrl K" off Mac (`CommunityShell.tsx:429`).

### Things worth a look while you're there
- **IP record on contributor projects.** It never shows, because DaoOverview drops its children (`DaoOverview.tsx:652`). Contributors most need to know who owns what they build. Render IpRecordCard for contributor projects, using wording without a raise. *Confirmed, high.*
- **Raise builds only, low priority:**
  - The sandbox promises create and bid but is view-only, and uses retired mint/six-share terms (`sandbox.ts:39`).
  - Funding chips hide while a filter is active, leaving no way out (`LaunchesPage.tsx:338`).
  - A pledge can't be withdrawn (`revenue-pledge.ts:106`).
  - There are eight copied "USDC" label ternaries (`RecordTab.tsx:238` and others).
  - Zero-count chips.

---

## 4. Copy

Except where marked *checked*, these were not verified. Use them as proposals.

### Problems that repeat across screens
1. **"Channel" and "room" for one thing** (*checked*). The sidebar says "Channels", "New channel" and "Load more channels" (`ChannelSidebar.tsx:85,248-303`), and room notes say "created this channel" (`system-notes.ts:127-180`). The headers and cards say "Edit room" and "Share this room". **Use "room" everywhere users can see**, and leave test ids alone.
2. **"Project" means three things.** The setup presets "Creative project / Technical project" (`template-copy.ts:38`) only add rooms. The contributor project is what Start makes. The Projects board is a pitch directory, and "Open the project board" (`LaunchDiscussion.tsx:137`) means a discussion board. The budget vote says "per project" when it means per work area (`daoActions.ts:267-346`). Suggestions: "For creative work / For software", "Open roles" for the pitch directory, "the project's board", "work area".
3. **"Tokens" and "Shares" for one holding.** See `ChallengeMilestones.tsx:123-269`, `RecordTab.tsx:292`, `ip-record.ts:213`, `LaunchCard.tsx:189`, and lowercase "shares" in `RagequitPanel.tsx:342-384`. Always write "Shares".
4. **"Mute" means two opposite things.** A personal mute hides someone from you. The moderator sanction also says "Mute everywhere" and "You are muted…" (`ModerationQueuePanel.tsx:38`, `refusal-text.ts:51`). Call the sanction "Pause posting".
5. **One concept, five names: "Done when"** (*checked*). See `FileClaimCard.tsx:554-601`, `WaysToHelp.tsx:120`, `FirstProjectsField.tsx:126`, `PendingWordsNote.tsx:31`. Also, "Finish the review" and "Mark it finished" are two steps with one verb (`work.ts:607/674`). The same wait is called "challenge window" in `work.ts:680` and `dao-overview.ts:175/415`, and "waiting period" in `FileClaimCard.tsx:454`. Claim chips show contract states like "Rejected" and "Recovered" (`work.ts:310`).
6. **The machine voice.** Examples: "The server did not change who can join, so it is as it was." (`PeopleSection.tsx`, `BanPanel.tsx`); "did not answer the history query… not known to be empty" (`ChannelTimeline.tsx:873`); "the client keeps retrying" (`:723`); "feed query" and "directory request… we're not showing an empty list, because…" (`SocialHomePage.tsx:203`, `DiscoverPage.tsx:226`). Owner-only actions also end with "ask the community's owner". The fix pattern is "Couldn't X. Try again in a moment."
7. **Protocol internals in main copy.**
   - `nostr:npub1…` in the post box.
   - `image/gif` (`upload-limits.ts:47`).
   - `floorPrice:` and milli-bips (`ParamIssueList.tsx:22`).
   - Hex claim and budget ids and "network (11155111)" (`TaskDeliveryPanel.tsx`, *checked*).
   - "contributor kit" (`ContributorFundsTab.tsx:122`, `DiscoverCards.tsx:102`).
   - "SHA-256" (`IpDocumentField.tsx:90`).
   - "No chain data" (`widgets.tsx:153`).
   - Raw "restricted:" posted by the tab helper (`browser-agent.ts:437/481`).
   - Report refusals such as "Report target event not found" (`readable-error.ts:96`).
   - "@buzz-tab" (`FleetView.tsx:305`).
   - Raw JSON scopes (`ProjectAgents.tsx`).
8. **Desktop-era leftovers.** "Join in browser" (`InvitePage.tsx:494`, `CommunityHomePage.tsx`), "Open in Creaton", "(top right)".
9. **Two verbs for one action.** Wallets say both "link" and "connect" (`PaymentWalletCard.tsx`). The passkey lock is called "Unlock", "Sign in with passkey" and "Unlock with your passkey" in different places (`nostr-signer.ts:54`, `query-error.tsx:20`). Pick "connect" and "Unlock".
10. **"Back" has three meanings** (fund a launch, support a decision, point bounty money). "Loot" and "new units" both name non-voting shares.
11. **Report reasons are named differently by reporter and moderator** ("Abuse or hateful language" shows up as "Profanity"; `moderationQueue.ts:150`). Use `REPORT_REASONS` labels on both sides.
12. **Dates and small inconsistencies.** One mute shows in three date formats (`BoardList.tsx:390`). "Communities" is used for boards (`BoardDirectory.tsx:69`). "Short name" means two things (`SuggestedWork.tsx:146` vs `ContributorStartPage.tsx:444`).

### The most important single rewrites

| Where | Now | Suggested |
|---|---|---|
| `BanPanel.tsx:60-63` (*checked*) | "…They are told the reason you give." | "{name} is signed out right away and can't come back, even with an invite link, until the ban ends or you lift it." Reason field: "Reason (only moderators see it)". This holds unless the server starts delivering the reason. |
| `ModerationQueuePanel.tsx:204` | "Passed on to the people who run this server." | "Marked for the server's owner. Nobody has picked it up yet." |
| `TaskPlanningPanel.tsx:142-147` (*checked*) | "Points… add to the contributor's share of the project… Arrange payment separately or use the DAO's Work tab for a funded claim." | "Points show on your profile once a reviewer accepts the task. They are not Shares and are not money. To earn Shares, take the work on the project's Work tab." |
| `TaskDeliveryPanel.tsx:128-232` (*checked*) | "Delivery & payment" / "Onchain claim" / "claim 0x12ab… · budget 0x9f8e…" / "Select this project's network (11155111)…" | "Where this work went" / "Matching piece of work on the project" (named by title and contributor) / "Can't read this project's work right now. Try again." |
| `PostComposer.tsx:521` | "Also share with other apps (copies there can't be deleted)" | "Also post this publicly outside Creaton (can't be deleted there)". Applies to this post only. |
| `post-bounty-copy.ts:39-41` (*bug, checked*) | "The court did not uphold the work in time." (also shown when it did uphold) | Upheld: "The court ruled for {name}'s work, but nobody paid it by {date}. Everyone can take their money back." |
| `rounds-copy.ts:144-153` (*bug, checked*) | Funding bid: "Bid at least 1.65 USDC a Share: what leaving pays." | "Bid at least 1.65 USDC a unit: the sale's lowest price." |
| `work.ts:607`, `WorkTab.tsx:872/910` | "Finish the review" … later "Mark it finished" | "Confirm the approval" ("…the 7-day wait starts then") … later "Make it ready for a Shares award" |
| `work.ts:680-682` | "Approved. It can be marked finished once the challenge window ends." | "Approved. On {date} you can mark it finished. Until then, Shareholders can still question it." |
| `FileClaimCard.tsx:554-589` | "How it should be judged" / "The work area's acceptance check, in its exact words" / "These are the words Docs was set up with." | "Done when (from the work area)" / "Copied from Docs. If you change it, the work can't be accepted for review." |
| `SuggestedWork.tsx:199` | "…so everyone else's part shrinks by that much." (misstates dilution) | "Everyone else keeps 94.9% of what they hold." |
| `ReviewersPicked.tsx:158` / `contributor-project.ts:428` | Two-reviewer advice the form never accepts; quorum "from 1 to N" | "Name at least 3 reviewers (you have 2)." Quorum: "a whole number from 2 to {n}". |
| `contributor-gate.ts:88-94` | "…this app does not know a contract there that makes one." | "Projects can't be started on {label} yet. Ask the person who runs this Creaton server to turn them on." |
| `AccountStrip.tsx:234` | "You act with your account (passkey; fees are covered on the test network)." | "You're signed in with your passkey. Fees are paid for you on this test network." |
| `InvitePage.tsx:494/516` | "Join in browser" / "No account yet? Pick a name and we will make one in this browser." | "Join this community" / "New here? Pick the name people will see." |
| `SocialHomePage.tsx:203`, `DiscoverPage.tsx:226` | "The server did not answer the feed query…" / "…We're not showing an empty list, because…" | "Couldn't load posts. Check your connection and try again." / "Couldn't load projects. Check your connection and try again." |
| `ChannelTimeline.tsx:723/873` | "Live updates… the client keeps retrying." / "…history query… not known to be empty." | "New messages aren't arriving right now. Trying to reconnect…" / "We couldn't load the messages in #general. Check your connection and try again." |
| `nostr-signer.ts:54` | "Unlock your passkey before this browser can sign." | "Your account is locked. Unlock it with your passkey to carry on." |
| `starter-boards.ts:22` | "supporters" board "for everyone who follows or backs this project", "founders", "What we can show supporters" | "community" and "team" boards. "follows or helps with". "What we can show everyone else". |
| `template-copy.ts:38` / `StartProject.tsx:273` | "Creative project… made with AI helpers" / "Setting up AI Media Studio" | "For creative work: Rooms and boards for film, music, audio or other creative work." / "Setting up your community…" |
| `ProjectFocusCard.tsx:335/344` | "Now" / "Set Now" | "What we're working on now" / "Set priorities" |
| `home-steps.ts:63` | "Add your name and a picture" with the hint "The picture is optional." | "Add your name". Hint: "A picture helps people recognise you." |
| `report.ts` refusals via `ReportDialog.tsx:149` | "Report target event not found." | "That message is no longer here, so it can't be reported. If it's still a problem, report the person instead." |

---

## 5. Bugs

Ordered by harm. All of these were confirmed by the verifier unless noted.

**Can lose data, privacy or access**
1. **Sticky public copying of votes and replies** (`use-feed.ts:285`, `PostComposer.tsx:282`). Someone ticks "share with other apps" once. From then on, every up/down vote and reply on Home short posts goes to relay.damus.io and nos.lol for good, including on an invite-only server.
2. **Public mute list** (`use-social-actions.ts:43-111`). Alice mutes a harasser. Kind 10000 is not author-only (`kind.rs:184`), so the harasser can read that Alice muted them.
3. **One-click account deletion** (`ProfileMenu.tsx:660-667`). A passkey user who hasn't saved the key presses "Remove passkey sign-in". The random salt is deleted from localStorage and the account is gone for good.
4. **Unlock re-prompt loop** (`PasskeyUnlockGate.tsx:46-51`). The person cancels the system prompt. The effect re-fires and prompts again, over and over, and there is no Sign out button.
5. **Ban reason never delivered** (`BanPanel.tsx:60-63`, `moderation_commands.rs:207-220`). The owner bans someone for 7 days "with a reason". The banned person only ever sees "You are banned from this community.", with no reason and no end date.
6. **Wrong scheme saved for good** (`relay-url.ts:36`). On the https hosted app, "Join" on a directory card saves `ws://host`. The browser blocks it, every reload stays broken, and `/repos`, the only fix, is hidden in the pilot.
7. **Pilot setup writes helper records** (`apply.ts:175`). A pilot owner presses Set up community, and six helpers, seats and a limit are written to a server with no AI service.

**Tells people something false**
8. **Queue ban reported as failed** (`use-moderation-queue.ts:332-354`). The ban succeeds but resolving the report fails. The row says "Couldn't apply the action", and the moderator bans again or reports a phantom failure.
9. **Refusal described as silence** (`WorkBoard.tsx:343`, `FleetView.tsx:234/367`, `SearchResults.tsx:121`). The server refuses (CLOSED), and the panel says "The server did not answer…", sending people to check their connection.
10. **Malformed directory crashes the page** (`use-communities.ts:38`). `communities` is not an array, so the whole route shows "Something went wrong" and the person's own community card disappears.
11. **Court ruling misreported** (`post-bounty-copy.ts:39-41`). The court upheld the work, but nobody pressed Pay within the grace period. The card says the court "did not uphold" it.
12. **Funding bid wording** (`rounds-copy.ts:144-153`). A too-low bid says "a Share… what leaving pays", which is wrong for funding.
13. **Points claims can't be accepted in the web app** (`TaskPlanningPanel.tsx`). A claim stays "pending" forever, because only the CLI accepts.
14. **Claim offered again after it was made** (`BoardIdeas.tsx:269`, `TaskPlanningPanel.tsx:83`). After a reload, "Claim 5 points" is back, and pressing it gives "This credit has already been claimed."
15. **Get started ticks too early** (`home-steps.ts:73`). Following one person ticks "Look at a project" without any project being opened. *Adjusted:* following projects should still count.
16. **Org counts are wrong** (`OrgView.tsx:264-283`). One team plus one role shows "2 teams". "Seat" means a person on one screen and a slot on another.
17. **Sandbox overpromises** (`sandbox.ts:39`, raise builds). It says "create, bid…", but every action is hidden, and it shows a retired mint/six-share raise.

**Silently does the wrong thing**
18. **Text rewards become no reward** (`BoardIdeas.tsx:104`). Reward "fifty" leads to a task with no reward and no author credit, and the toast still says "Made into a task".
19. **Ask above the area's money** (`FileClaimCard.tsx:283`). A contributor asks for 400 USDC from an area with 200 left. The claim files, the deposit is pulled, and no manager is ever offered Accept. It shows "Waiting for … to accept" until it lapses.
20. **Pasted-link moderator skips the confirm** (`BoardModerationPanel.tsx:158-166`). A moderator appointed from a pasted link gets 30-day powers without ever being named on screen.
21. **Helper stuck "in progress"** (`browser-agent.ts:476-483`). After an AI timeout the helper's task stays "in progress" forever, its failure note lands outside the thread, and a retry is blocked. Raise builds only.
22. **Mentions don't work from the keyboard** (`Composer.tsx:258`). Type "@Ali" and press Enter: the message sends as plain text, and Alice is never notified.
23. **Sign-out confirm is not a dialog** (`ProfileMenu.tsx:782`). Screen readers aren't told it opened, and Tab walks behind it.
24. **Unread count hidden from screen readers** (`NotificationBell.tsx:92`). The label is always "Notifications", whatever the count.
25. **Checklist state is visual only** (`HomeHero.tsx:241`). Done and not-done are not announced, and every action is "Go".
26. **Phishable score link** (`use-launches.ts:167`, `OverviewTab.tsx:468`). Any member's 37006 becomes the "View proofs and scores" link on every project page.
27. **Hidden filter chips leave no way out** (`LaunchesPage.tsx:338`, raise builds). Pick "Raising now", switch to an empty tab, and the chips you'd need to clear are hidden.
28. **Stale AI advice** (`WorkCheckAi.tsx:25-45`). The old "I could not open the link…" list stays after the evidence is fixed.
29. **Wrong shortcut hint** (`CommunityShell.tsx:429`). It always shows "⌘K", though Ctrl+K works too.
30. **Test-order cascade** (`contributor-journey.spec.ts:253`). `docsCommonsPublished` is set before the launch succeeds, so test 2 fails as a misleading remix failure.
31. **No way to withdraw a pledge** (`revenue-pledge.ts:106`, raise builds).
32. **Wrong currency label, latent** (`RecordTab.tsx:238` + 7 copies). A non-USDC ERC-20 would show as "USDC". Medium confidence: it needs a hand-published record.

---

## 6. The tests themselves

### Structural fixes
- **Cover the pilot build.** Three areas independently found the same gap. The verifier's cheapest path:
  1. Unit-test the gates with the env passed in: the `planApply` contributor filter, `templateCounts`, `raisesOffered`, and DmView's "Notices" copy.
  2. Add pilot-copy assertions to `passkey-contributor.spec.ts`, which already runs a contributor-only build.
  3. Add a small `@pilot` browser check, run against a `VITE_CONTRIBUTOR_ONLY=1` dist via `E2E_DIST`/`E2E_PORT`. It asserts that fleet-toggle, org-toggle, Repositories, the sale wizard and "Back this launch" are absent, and that Discover (Projects/Ideas, "Start a project"), Start ("Build with contributors" only), "Your work", the Ideas list empty state, the Tasks board (no `0x`, no "network ("), and a11y-phone/a11y-pilot on contributor pages all work.

  A full second smoke project is the heavier option (see section 8).
- **Make skips visible.** Thirteen chain specs skip in `smoke`. Moving them means changing every `scripts/web-*-e2e.sh` call that uses `--project=smoke` in the same change. At minimum, add `web-rounds-e2e` and `web-post-bounty-e2e` to `mvp-gate.sh`'s LATER list, because no gate runs them today.
- **Add a mocked happy path for the core loop** on the stateful `/test-rpc` stub from `launchpad-shouldfix-work`: submit, accept, approve ×2, finish the review, advance the clock, mark it finished, then back and run a decision.

### Assertions that can't fail (fix these first)
- `board.spec.ts:1208`: `.catch(() => undefined)` around the wrong order. It should be `["Ordinary post", "Newest proposal", "Loved proposal"]` with no catch.
- `chat-removal.spec.ts:175-180`: a swallowed `toHaveCount(0)`. Remove the `.catch`.
- `post-bounty-journey.spec.ts:283-300`: "a dip stops it" passes either way. Pass 7 days after the re-back and assert it is still not payable, then 2 more days.
- `post-bounty-journey.spec.ts:402`: Ben's page is never refreshed, so the refund-absent check is trivially true. Add `refresh(ben)`.
- `smoke.spec.ts:1461`: `/Reconnecting|Connecting/` passes before any drop. Use an exact "Reconnecting…".
- `smoke.spec.ts:1126`: negative chunk-name checks pass if the chunk is renamed. Prove the positive side too.
- `browser-agent.spec.ts:101-114`: `expect(announced).toBeUndefined()` is always true. Assert the announced content instead.
- `polling-bounds.spec.ts:54-62`: accepts a pause at any minute and never checks requests stop or restart.
- `launchpad-record.spec.ts:109` `toContainText("0")` and `launchpad-milestone.spec.ts:301` `toContainText("1")`: use exact values.
- `home-checklist.spec.ts:92`: seeds localStorage instead of opening a project. Deleting `markFirstStep` (`LaunchDetailPage.tsx:134`) would still pass.
- `responsive-surfaces.spec.ts:261-295, 382`: overflow is measured without waiting for the surface to appear.
- `sandbox.spec.ts:43`: the origin test builds its own iframe. Render the real repo HTML preview and assert `sandbox="allow-scripts"`. Keep the CSP probe, and rename the file `repo-preview-sandbox.spec.ts`.
- `launchpad.spec.ts:479`: "bid-record disabled" is checked on an empty form. The "main button" test (`:1106`) never covers the live stage.
- `multi-user.spec.ts:410` (`ml-8` class) and `:1081` (`bg-black/10`): assert `aria-current` and the reply's parent `e` tag instead.
- `multi-user.spec.ts:75`: the "author" context does nothing, and the passkey test ends on any alert.
- `feed.spec.ts:122`: titled "trust-weighted" but checks only the headcount, and line 126 has a stale comment. Rename it, and test Hot ranking at its own seam.
- Missing positive checks: `board.spec.ts:1368` (signed-out Report prompt), the report-sent toast (`:1333`), the dao-launch no-wallet reason (`:654`), and an archived community showing no "Try again".

### Tests that lock in wrong behaviour (change them with the fix)
- `social-mention.spec.ts:55` (`nostr:npub` in the box)
- `smoke.spec.ts:221` (`ws://`)
- `smoke.spec.ts:668` (crash on malformed directory)
- `invite-join.spec.ts` (Join enabled after expired)
- `community-access.spec.ts:761-783` (For-good default; select "For good" explicitly)
- `board-ideas.spec.ts:298-305` (claim again, then error)
- `smoke.spec.ts:298-306` (links with no underline)
- `report.spec.ts` (raw refusal text)
- `browser-agent.spec.ts` (`/Task failed: restricted/`)
- the `floorPrice` assertion
- the `contributor-journey.spec.ts:222` raise-only heading. Assert "New Shares come only from awards" instead.

### Merge, move or drop
- `smoke.spec.ts:12` branding test: drop. Fold the `:72`/`:91` directory tests into the parametrised 200/404 test. Move the stored-identity invite claim (`:1989`) into `invite-join.spec.ts`. It is not a duplicate, so keep it.
- `smoke.spec.ts:411-601` desktop-download tests: move to a desktop-only spec.
- `community-create.spec.ts:148-156` desktop side-by-side layout: drop, or fold into the phone test.
- `screenshots.spec.ts`: run only when `E2E_SHOTS` is set, and use MVP-like messages. `dao-os.spec.ts:483-543`: drop the uncompared `/private/tmp` screenshots and add a contributor-page overflow check. `projects.spec.ts:627`: drop the uncompared screenshots and run at 390px only, keeping the dark theme, keyboard and focus checks. Fix the `desktop/tests/helpers` import in three web specs.
- `usernames.spec.ts`: keep "no name is Your account" (move it to Home). Move the other three to `user-label` unit tests.
- `tour.spec.ts` and `first-run.spec.ts:31-112`: rebuild around the pilot's first hour (invite, passkey, save key, Get started, contributor project).
- `signing-recovery.spec.ts`: move from `/launchpad` and `/projects` to Home posting and contributor accept.
- `live-scope.spec.ts`: retarget from fleet-toggle to Tasks (work-toggle), which uses the same subscription rule.
- `launchpad.spec.ts:113`: reset `published.length = 0` in `beforeEach`. Split directory, detail and track-record tests out before moving the raise tests to a raise/later project.
- `social-shouldfix-*.spec.ts` grab-bags: move tests to files named after their feature (low priority).
- `a11y-phone.spec.ts:32`: one test per page and scheme, waiting for a landmark instead of 600 ms.
- Fixed sleeps used as "nothing happened" checks: replace with readiness signals. Keep `social-shouldfix-messages:553` (1.1 s), which is needed for second-granular timestamps, and the 300/500 ms waits the verifier found harmless.
- `org-chart.spec.ts:107`: use `createMockRelay` (it ignores `E2E_PORT`) and expect the setup wizard.
- `start-project.spec.ts:96`: optionally split it into picker/preview and "what it writes".

### Most important missing tests
1. Mocked core-loop happy path (above).
2. Working cycle: Set Now with "Check by", take on and let go, the interview's must-read gate, check note plus Apply to Now after a failed save, the challenge brief, and the AI-unavailable (404) path.
3. Moderation recovery: Lift mute, Remove as moderator through the confirm, Step down, and a refused action shown in `role=alert`.
4. Queue Remove (with reason) and Dismiss.
5. Production passkey: sign up, reload and unlock, then Remove with the warning.
6. Votes don't mirror after the share box is ticked.
7. Home's default Hot order puts "Keeping a character steady" above "Splitting album royalties".
8. Invite loop: the owner makes and copies a link ("Link copied."), and a newcomer opens it and joins.
9. Ctrl+K. Keyboard mention pick, with the second context's bell ringing.
10. Rounds: cancel sell/bid, a void round with Collect, and the unlinked challenge state.

---

## 7. Quick wins

Best value for little work, in order:

1. **Make the dead assertions real.** Remove the `.catch` in `board.spec.ts:1208` (and fix the order) and in `chat-removal.spec.ts:175`. Add `refresh(ben)` and the day-10 check in the post-bounty spec. Make "Reconnecting…" exact. About 20 lines.
2. **Confirm before "Remove passkey sign-in"** by reusing the Sign out ConfirmDialog with the no-backup warning (`ProfileMenu.tsx:660`).
3. **Fix the unlock loop** with a `useRef` guard and a "Sign out" link (`PasskeyUnlockGate.tsx:46-51`).
4. **Pick `wss://` on https pages** for bare hosts (`relay-url.ts:36`), and update `smoke.spec.ts:221`.
5. **Pass `error` to QueryError** on the four panels so refusals are named honestly.
6. **Hide or scope the share-with-other-apps box.** Gate it on the contributor-only build and on invite-only servers.
7. **Add three missing `raisesOffered()` gates:** the funding decision and FundingCard, "Use my wallet instead", and cashtag price chips.
8. **Clear out desktop leftovers.** Gate "Open in Creaton" on `DESKTOP_APP`. "Join in browser" becomes "Join this community". "(top right)" becomes a toast with a "Create your account" action.
9. **Make the ban form honest.** Remove "They are told the reason you give", label the reason "only moderators see it", and preselect no ban length.
10. **Replace "channel" with "room"** in user-visible strings (`ChannelSidebar.tsx`, `system-notes.ts`, `ChannelTimeline.tsx`, `CreateChannelDialog.tsx`), and fix the points-vs-Shares sentence in `TaskPlanningPanel.tsx:142`.

Close runners-up: validating the directory shape (`use-communities.ts:38`), the bounty "upheld" line, the funding bid wording, `published.length = 0`, Reward number validation, and the bell's `aria-label`.

---

## 8. Decisions for the owner

1. **Community Tasks board in the pilot.** Should it become plain to-dos (hide points and Claim), link each task to a project work area, or be hidden so work areas are the only task system? Today it offers claims nobody in the web app can accept.
2. **Escalate.** Hide it in the pilot, or give the operator a real receiver (`buzz-admin reports --escalated` plus a runbook line saying who checks it and how often)?
3. **Ban reasons.** Change the server so a banned person sees the reason and end date in the refusal, or change the copy to say only moderators see the reason?
4. **The "Mark it finished" step.** Put a contract change on the audit backlog (anyone can call payout on zero-amount claims, and the approval that reaches quorum settles the claim), or keep the steps and rely on UI nudges (date in the status line, Needs you, a waiting list in the award form)?
5. **Pilot coverage approach.** Unit tests on the gates plus a small `@pilot` browser check (cheap), or a full second Playwright project built contributor-only, with the raise and chain specs moved to a `raise`/`chain` project and every script updated (thorough, more work)?
6. **Moderation depth for a few-person pilot.** Hide the second-moderator long mutes (and possibly the moderator terms and rate limits) in the dialog for now, or keep them?
7. **Features after the pilot.** Keep or retire the Projects board (% stakes outside reviewed work), post bounties (a second payment path decided by money rather than reviewers), and the panel milestone mode (needs a pre-audit decision because of `AUDIT-SCOPE.md`)?
8. **Wording choices.** Recommendations:
   - "room" over "channel"
   - "Pause posting" for the moderator sanction, keeping "mute" for the personal action
   - "Done when" for the work-area check
   - "priorities" instead of "Now"
   - setup presets "For creative work / For software" instead of "Creative/Technical project"
   - starter boards "community/team" instead of "supporters/founders"
   - "Open roles" for the pitch directory
   - "non-voting shares" instead of "Loot"/"new units"
   - "connect" over "link" for wallets
