# Copy pass 1: plain words

For the owner and counsel. Prepared 2026-11-05 from `git diff cee4b37ddc92033d28b13683ff7330194b93dfee..HEAD` restricted to `web/`, test files left out. Companion to the guide [PLAIN-WORDS.md](PLAIN-WORDS.md).

## 1. What this pass did and did not do

**It did.** It rewrote the words a first-time reader meets in the web app (236 source files) so that a sharp person who has never used crypto, a DAO, a code host or a wallet can follow them. Insider words such as treasury, DAO, claim, wallet, chain, hash, transaction, bond, graduation and tranche became everyday ones (the project's money, the project, submission, wallet app or account, network, fingerprint or confirmation ID, put down, a batch), and a one-line meaning was added where a hard word first appears (DAO, bond, IP, fingerprint, graduation, wallet). Error messages now end with what to do next. Raw details (record numbers, file-format names, the server's own message) moved under a collapsed Technical details line. Tests and browser specs that pin the old sentences were updated by text only.

**It did not.** It changed no number, percentage, date, unit, economic parameter or logic. A mechanical check of every edited line found numbers changing only in format hints (for example a hex-length hint reworded as '64 letters and numbers') and in record numbers moved under Technical details; none is an economic figure. It did not touch the switch that keeps trading off by default in hosted and pilot builds. It added nothing to the allowlist in `web/scripts/check-copy.mjs` (the file is unchanged since the starting commit). `pnpm check:copy` passes at the current commit. The guide's rule was to record legally loaded lines rather than rewrite them; the pass followed that for the lines in section 3, but it did simplify the words around some legal lines (sale terms, bond, exit), and those are listed there too so counsel can re-read them.

**This document** is docs only. It changes no product text.

Also changed outside `web/` (listed because the web app shows it): `packages/creaton-core/src/launchpad/auction-copy.ts`, the deploy-step labels and errors. For example 'Bid gate' became 'Bid limits', 'Publish the sweep receipt' became 'Publish the transfer receipt', and 'was reverted onchain' became 'was rejected by the network'.

Commits in the range (`git log cee4b37ddc92033d28b13683ff7330194b93dfee..HEAD --oneline`). Three of them are not copy commits (`b1bf925` and `ef55af2` the policy drafts and the lawyer-review response, `7d915f2` the Sepolia deploy script) and change nothing under `web/`.

```
b1bf925 Policy drafts (review fixes): match claims to what the software does
f2e9332 Plain words (gate fixes): update test pins to the new wording
ef55af2 Respond to the lawyer's review in the terms, privacy note and policy README
7d915f2 Deploy the launch path to Sepolia and let the deploy script price gas like the live network
264fdcd Plain words (review fixes): say what happens past a budget limit
1deb54e Plain words (review fixes): drop record numbers, one limit word, room list
c492552 Plain words (review fixes): decisions and rules follow-ups
c3aafa9 Plain words (review fixes): account not wallet, bond explained, one name for reviewers
a77bc5a Plain words (review fixes): weekly sales and bids
703ff74 Plain words (review fixes): money surface
0420362 Plain words (review fixes): creating a project
9b21240 Plain words (review fixes): browsing surface
1645533 Plain words (review fixes): one name for the saved account and the start-over action
c51fbd9 Plain words: community side copy (fleet, wiki, budgets, moderation, board, repos)
13bdd9f Plain words: app shell errors, empty states, rooms and approvals
f1601ce Plain words: decisions, voting, court, enforcement, trust and manage copy
8f50092 Plain words: work, milestones, claims, checks and agreed terms copy
22d7c97 Plain words: weekly sales, bids and trading copy
4ead7ff Plain words: money, funding, exits and account copy
bf88d03 Plain words: project creation, sale plans, share rules and unlock plans copy
3c52f00 Plain words: browsing, projects and portfolio copy
4d963b8 Plain words: first-run copy for sign-in, passkey, profile, invite, start and communities
b5fb6d4 Add a plain-words guide for the product copy
```

## 2. Before and after, by surface

How to read it. Each block is one source file (path relative to `web/`). Before is the text at the starting commit, After is the text now, quoted from the diff. Some cells show a whole line of source because the sentence sits in code; the sentence is the part in quotes. `(nothing)` in Before means the text is new. Plain wrappers such as `${...}` are live values the screen fills in. Trivial changes are folded into one 'Also' line per file: a server message that now ends with 'Try again.', or a fix of spelling, punctuation or capitalization only.

### App shell, rooms, search, notifications and errors

**`app/BoundaryViews.tsx`**

| Before | After |
|---|---|
| `Something went wrong` | `This page hit a problem` |
| `This view stopped responding to its data. Reloading usually clears it.` | `This page couldn't show its content. Try again, or reload the page.` |
| `Nothing here` | `Page not found` |

**`app/TestnetTag.tsx`**

| Before | After |
|---|---|
| `Testnet` | `Test version` |
| `<span>Testnet</span>` | `<span> Test version </span>` |

**`features/channels/lib/channel-templates.ts`**

| Before | After |
|---|---|
| `name: "Blank channel", summary: "Start from scratch. Pick members yourself."` | `name: "Blank room", summary: "Start from scratch. Choose who joins yourself."` |
| `name: "Agent workspace", summary: "A channel where every agent in your community is a member."` | `name: "AI helpers room", summary: "A room that every AI helper in your community joins."` |
| `Working session with the community's agents.` | `Working session with the community's AI helpers.` |
| `A private channel for one team's agents.` | `A private room for one team's AI helpers.` |
| `no agents found in this community` | `no AI helpers in this community` |
| `no agents found for team "${teamName}"` | `no AI helpers found for team "${teamName}"` |
| `agent "${seat.agentId}" not found` | `AI helper "${seat.agentId}" not found` |

**`features/channels/ui/ChannelTimeline.tsx`**

| Before | After |
|---|---|
| `Live updates from the server have stopped; the client keeps retrying.` | `Live updates have stopped. This page keeps trying to reconnect.` |
| `Showing live messages only. The server didn't answer the history request for this room.` | `Showing new messages only. The server didn't send this room's earlier messages.` |
| `The server did not answer the history query for #${channel.name}, so this room is not known to be empty.` | `The server did not answer when asked for the messages in #${channel.name}, so we can't tell whether the room is empty.` |
| `The message is replaced with a deletion marker for everyone in this room.` | `Everyone in this room will see 'message deleted' in its place.` |

**`features/channels/ui/CommunityShell.tsx`**

| Before | After |
|---|---|
| `aria-label="Close channel list"` | `aria-label="Close room list"` |
| `aria-label="Open channel list"` | `aria-label="Open room list"` |
| `Pick a creative or a technical project and this community fills with channels, AI helpers and shared pages.` | `Pick a creative or a technical project and this community fills with rooms, AI helpers and shared pages.` |
| `Select a channel to start reading.` | `Select a room or board to start reading.` |

**`features/channels/ui/CreateChannelDialog.tsx`**

| Before | After |
|---|---|
| `Some template members weren't found:` | `We couldn't add everyone this template asks for:` |

**`features/communities/ui/CommunityHomePage.tsx`**

| Before | After |
|---|---|
| `This community is archived, so its channels are no longer served.` | `This community is archived, so its channels are no longer available.` |
| `Joining doesn't require an account here. Creaton creates a local identity only when you post or join privately.` | `Joining doesn't need an account here. An account is made in this browser only when you post or join privately.` |

**`features/dms/DmView.tsx`**

| Before | After |
|---|---|
| `The server didn't answer the conversation list, so it is not known to be empty.` | `The server didn't answer, so we can't tell whether you have any conversations.` |

**`features/feed/ui/ProjectProgressFeed.tsx`**

| Before | After |
|---|---|
| `Retry follows` | `Try again` |
| `<p>Reading progress…</p>` | `<p>Loading updates…</p>` |
| `No reports in this view yet. Follow a project or share what shipped, an artifact and what comes next.` | `No updates here yet. Follow a project, or share what you finished, the work you made and what comes next.` |
| `The shared report was not found in the latest loaded updates. This does not mean it was deleted.` | `That update is not among the latest ones loaded here. This does not mean it was deleted.` |
| `Showing the latest 100 loaded reports.` | `Showing the latest 100 updates.` |

**`features/feed/use-feed.ts`**

| Before | After |
|---|---|
| `publishAsUser(template, "The server refused this change to your follows.")` | `publishAsUser( template, "The server did not accept this change to who you follow. Try again.", )` |
| `const signed = await publishAsUser(template, "The server refused this post.")` | `const signed = await publishAsUser( template, "The server did not accept this post. Try again.", )` |

**`features/notifications/lib/approvals.ts`**

| Before | After |
|---|---|
| `rows.push({ label: "Agent", value: resolveName(request.subjectPubkey) })` | `rows.push({ label: "AI helper", value: resolveName(request.subjectPubkey), })` |
| `rows.push({ label: "Counter", value: request.counterType })` | `rows.push({ label: "Measured by", value: counterWords(request.counterType) ?? request.counterType, })` |
| `rows.push({ label: "Window", value: request.window })` | `rows.push({ label: "Period", value: request.window })` |
| `"Budget approval needed" : "Approval requested"` | `"AI helper limit reached" : "Your approval is needed"; } function counterWords(counterType: string \| null): string \| null { if (counterType === "runs") return "runs"; if (counterType === "llmCostCents") return "cents of AI spending"; return null` |
| `A workflow is waiting for approval.` | `An automation is waiting for your approval.` |
| `` const counter = request.counterType ?? "spend"; const windowPart = request.window ? ` per ${request.window}` : ""; const limitPart = request.limit !== null ? ` (limit ${request.limit}${windowPart})` : ""; return `An agent hit its ${counter} budget${limitPart} and needs approval to continue.` `` | `` const unit = counterWords(request.counterType); const amount = request.limit !== null ? ` of ${request.limit}${unit ? ` ${unit}` : ""}${request.window ? ` per ${request.window}` : ""}` : ""; return `An AI helper has used up its limit${amount}. Approve to let it keep going.` `` |

**`features/notifications/ui/ApprovalsPanel.tsx`**

| Before | After |
|---|---|
| `an agent` | `an AI helper` |
| `` aria-label={`Approve ${approvalHeadline(item)}`} `` | `aria-label="Approve this request"` |
| `` aria-label={`Reject ${approvalHeadline(item)}`} `` | `aria-label="Decline this request"` |
| `Reject` | `Decline` |

**`features/notifications/ui/NotificationBell.tsx`**

| Before | After |
|---|---|
| `Workflow runs` | `Automations` |
| `<AlertDialogTitle>Workflow runs</AlertDialogTitle>` | `<AlertDialogTitle>Automations</AlertDialogTitle>` |

**`features/notifications/use-approvals.ts`**

| Before | After |
|---|---|
| `result.message \|\| "The server rejected the decision."` | `result.message \|\| "The server did not accept your decision."` |

**`features/search/ui/SearchResults.tsx`**

| Before | After |
|---|---|
| `The server did not answer the search query.` | `The server did not answer the search.` |
| `Search failed` | `Couldn't search` |
| `No results for “{term}”.` | `Nothing matches “{term}”. Try different words.` |

**`features/social/ui/ConversationPage.tsx`**

| Before | After |
|---|---|
| `Messages are end-to-end encrypted with your key.` | `Only you and the person you write to can read your messages.` |
| `No messages yet. Say hello. Messages are end-to-end encrypted.` | `No messages yet. Say hello. Only you and the person you write to can read your messages.` |

**`features/social/ui/MessagesPage.tsx`**

| Before | After |
|---|---|
| `Messages are end-to-end encrypted with your key.` | `Only you and the person you write to can read your messages.` |
| `Messages are end-to-end encrypted. Start one with the pencil above.` | `Only you and the person you write to can read your messages. Start one with the pencil above.` |

**`features/social/ui/SocialHomePage.tsx`**

| Before | After |
|---|---|
| `The server did not answer the feed query, so no posts can be shown.` | `The server did not answer, so no posts can be shown.` |

**`features/social/use-messages.ts`**

| Before | After |
|---|---|
| `The server refused this message.` | `throw new Error( r.message ?? "The server did not accept this message. Try again.", )` |

**`shared/lib/nostr-client.ts`**

| Before | After |
|---|---|
| `Failed to sign server authentication.` | `Couldn't sign you in to the server. Try again.` |

**`shared/lib/nostr-signer.ts`**

| Before | After |
|---|---|
| `A Nostr signer browser extension is required to join in the browser.` | `Joining from this browser needs a sign-in extension, and none was found.` |
| `Unlock your passkey before this browser can sign.` | `Unlock your passkey so this browser can confirm this.` |
| `The signer extension returned an invalid signature.` | `Your sign-in extension gave an answer we could not use. Try again.` |
| `Failed to create the ephemeral browser identity.` | `Couldn't set up a temporary account in this browser. Reload the page and try again.` |

**`shared/lib/relay-auth.ts`**

| Before | After |
|---|---|
| `Joining needs an account that survives a reload. Create your account here, or sign in with a signer extension.` | `Joining needs an account this browser keeps after a reload. Create your account here, or sign in with a sign-in extension.` |

**`shared/lib/relay-failure.ts`**

| Before | After |
|---|---|
| `export function relayFailureGuidance( message: string, kinds?: readonly number[], ): string {` | `export function relayFailureGuidance(message: string): string {` |
| `` const named = kinds && kinds.length > 0 ? formatKinds(kinds) : kindsNamedIn(message); const scope = named ? ` (kind ${named})` : ""; return `This server is running an older build that doesn't know these records${scope}. Restart it from the current build, or point the app at a newer server.` `` | `This server is older than this app and doesn't know some of these records. Ask whoever runs it to update it, or use a newer server.` |
| `The server answered but refused this request. Its own message is under Technical details. We're not showing a list, because an empty one would wrongly suggest there's nothing here.` | `The server refused this request. Its own message is under Technical details. We're not showing an empty list, because that would wrongly suggest nothing is here.` |

**`shared/ui/query-error.tsx`**

| Before | After |
|---|---|
| (nothing) | `` ) : null} {kindsDetail ? ( <p data-testid={`${testId}-kinds`}> Record numbers: {kindsDetail} </p> `` |

### Sign-in, passkey, account and wallet

**`features/identity/lib/mode-copy.ts`**

| Before | After |
|---|---|
| `Your passkey signs each time you post or vote` | `Your passkey asks you to confirm each time you post or vote` |

**`features/identity/lib/passkey-wallet.ts`**

| Before | After |
|---|---|
| `The signed link did not match your account. Nothing was published.` | `Your approval did not match your account. Nothing was published.` |

**`features/identity/lib/public-wallet.ts`**

| Before | After |
|---|---|
| `The saved wallet proof expired or is unavailable. Link your wallet again.` | `The saved wallet update expired or is missing. Connect your wallet again.` |
| `The active signer changed. Try again from the original account.` | `Your account changed. Try again from the account you started with.` |
| `result.message \|\| "The server did not accept the wallet proof."` | `result.message \|\| "The server did not accept the wallet update."` |

**`features/identity/lib/sign-recovery.ts`**

| Before | After |
|---|---|
| `This browser cannot sign until its passkey is unlocked.` | `This browser cannot confirm your action until its passkey is unlocked.` |
| `This browser has no passkey to unlock. Create one so signing has a key it can open.` | `This browser has no passkey yet. Create one so you can confirm your actions here.` |

**`features/identity/lib/siwe.ts`**

| Before | After |
|---|---|
| `Switch your wallet to chain ${chain}, then link it again.` | `Switch your wallet to network ${chain}, then connect it again.` |
| `The wallet signature did not match your account. Sign with an ordinary wallet, not a smart-contract one.` | `Your wallet's approval did not match your account. Use a standard wallet app, not a contract-based one, then try again.` |
| `Your account or community changed while signing. Try again.` | `Your account or community changed while you were approving. Try again.` |

**`features/identity/lib/wallet-chain.ts`**

| Before | After |
|---|---|
| `This site reads chain ${served}, not chain ${check.chain}.` | `This site reads network ${served}, not network ${check.chain}.` |

**`features/identity/ui/IdentityRecoveryBanner.tsx`**

| Before | After |
|---|---|
| `That recovery key couldn't be imported. Check it and try again.` | `That recovery key didn't work. Check that you pasted all of it, then try again.` |
| `Your saved key can't be read: import your backup or start over` | `Your saved account can't be read. Paste your recovery key, or start over.` |
| `This removes the unreadable key and starts over with a new one. It can't be undone.` | `This removes the saved account this browser can't read and gives you a new one. It can't be undone.` |
| `Reset` | `Start over` |

**`features/identity/ui/LinkDevicePage.tsx`**

| Before | After |
|---|---|
| `Sign-in did not complete. Try again, or open the link from the desktop app once more.` | `Sign-in did not finish. Try again, or open the link from the desktop app once more.` |
| `<h1> Create your identity first </h1>` | `<h1>Create your account first</h1>` |
| `There is no identity on this browser yet, so there is nothing to link to the desktop app. Sign in or create your identity, then open the desktop link again.` | `There is no account on this browser yet, so there is nothing to link to the desktop app. Sign in or create your account, then open the desktop link again.` |
| `Your saved identity can’t be read` | `Your saved account can’t be read` |
| `This browser has a saved identity but it can’t be opened, so nothing was shared with the desktop app. If you have a backup, import it in the app. Otherwise you can reset to a new identity. This discards the unreadable one for good.` | `This browser has a saved account but it can’t be opened, so nothing was shared with the desktop app. If you have your recovery key, paste it into the profile menu on this site. Otherwise you can start over with a new account. This discards the unreadable one for good.` |
| `Resetting removes the unreadable saved identity and creates a` | `Starting over removes the unreadable saved account and creates a` |
| `Reset identity` | `Start over` |
| `The desktop app will be able to sign as this account. Only confirm on a desktop you trust.` | `The desktop app will be able to act as this account. Only confirm on a desktop you trust.` |
| `Waiting for passkey…` | `Waiting for your passkey…` |
| `The handoff was opened on this device. Finish the steps in the desktop app to sign in there with this account.` | `The link was opened on this device. Finish the steps in the desktop app to sign in there with this account.` |
| `Nothing opened? Use this to open the desktop app again. It works only once, and only on this device.` | `Nothing opened? Use this button to open the desktop app again. It works only once, and only on this device.` |
| `<h1>Something went wrong</h1>` | `<h1>The link did not work</h1>` |

**`features/identity/ui/OnboardingDialog.tsx`**

| Before | After |
|---|---|
| `Your wallet did not sign in. Open your wallet, approve the request, then try again.` | `Your wallet app did not sign you in. Open it, approve the request, then try again.` |
| `Use my wallet instead` | `Use a wallet app instead` |

**`features/identity/ui/PasskeyUnlockGate.tsx`**

| Before | After |
|---|---|
| `Touch is required to unlock your account for this session.` | `Confirm with your passkey to unlock your account for this session.` |

**`features/identity/ui/PaymentRecipientPicker.tsx`**

| Before | After |
|---|---|
| `This person's wallet proof changed, expired or was removed. Ask them to confirm their payment wallet.` | `This person's payment wallet changed, expired or was removed. Ask them to connect it again.` |
| `Checking the latest proof…` | `Checking the latest details…` |

**`features/identity/ui/PaymentWalletCard.tsx`**

| Before | After |
|---|---|
| `You cancelled in your wallet. Try again when you are ready.` | `You cancelled in your wallet app. Try again when you are ready.` |
| `Your wallet is on another network. Switch networks in your wallet, then try again.` | `Your wallet app is on another network. Switch networks in it, then try again.` |
| `View on explorer` | `View public record` |
| `This account linked a smart account, which has to be checked on the network, and that check could not be made just now. Try again in a moment.` | `This account uses a wallet that can only be checked on the network, and the check did not go through. Try again in a moment.` |
| `A signed wallet update is saved in this browser but has not been confirmed by the server.` | `Your wallet change is saved in this browser, but the server has not confirmed it yet.` |
| `Projects send what you earn to this wallet. Connecting it does` | `This is where projects send what you earn. Connecting it does` |
| `Use your passkey account, or a wallet in this browser. The first time, your passkey account is set up for you at no cost.` | `Use your passkey account, or a wallet app in this browser. The first time, your passkey account is set up for you at no cost.` |
| `` "Set up passkey sign-in to be paid at your passkey account, or use a wallet in this browser." : `${passkeySetup.reason} You can use a wallet in this browser.`} `` | `` "Set up passkey sign-in to be paid at your passkey account, or use a wallet app in this browser." : `${passkeySetup.reason} You can use a wallet app in this browser.`} `` |
| `"Waiting for signatures…" : "Sign with my passkey account"}` | `"Waiting for your approval…" : "Approve with my passkey account"}` |
| `Waiting for signatures…` | `Waiting for your approval…` |

**`features/identity/ui/ProfileMenu.tsx`**

| Before | After |
|---|---|
| `Conversation density` | `Message spacing` |

### Start a project and templates

**`features/start/lib/contributor-flow.ts`**

| Before | After |
|---|---|
| `Make the project: its DAO, first work budget and work areas` | `Make the project: its shared money and rules, first work budget and work areas` |
| `this site cannot confirm that this project's kit made the DAO at the address this project would use. Nothing was sent. If you started this project a moment ago, press Try again in a minute. Otherwise discard it and start the project again: it then gets a new address.` | `We could not confirm that this project was made at the address we expect. Nothing was sent. If you started this project a moment ago, press Try again in a minute. Otherwise discard it and start the project again: it then gets a new address.` |
| `this network's contributor kit makes a different kind of DAO from the one the app reads. Nothing was sent.` | `This network makes a different kind of project from the one this app reads. Nothing was sent.` |
| `the network turned the transaction down, so nothing was made. Most often another project was being set up at the same moment: try again.` | `The network turned the request down, so nothing was made. Most often another project was being set up at the same moment. Try again.` |
| `it was sent and confirmed (${sent.txHash}), but this site's view of the network does not show the DAO yet. Press Try again in a minute: it picks up the DAO once it shows, and never makes a second one.` | `Your request went through (confirmation ${sent.txHash}), but this site cannot see the new project on the network yet. Press Try again in a minute: it picks the project up once it shows, and never makes a second one.` |

**`features/start/lib/contributor-gate.ts`**

| Before | After |
|---|---|
| `Unlock your passkey first: the project is published under your name, and this browser cannot sign until you do.` | `Unlock your passkey first: the project is published under your name, and this browser needs your passkey to confirm it.` |
| `Contributor projects cannot be started on ${label(chainId)} yet: this app does not know a contract there that makes one.` | `Contributor projects cannot be started on ${label(chainId)} yet: this app cannot make them there.` |
| `` `Set up passkey sign-in from your profile menu: your passkey account holds your starting Shares and makes the project${wallet.passkeyFeesOn ? `, with its fees covered on ${wallet.passkeyFeesOn}` : ""}. Or connect a wallet.` : "Connect a wallet. It holds your starting Shares and sends the one transaction that makes the project." `` | `` `Set up passkey sign-in from your profile menu: your passkey account holds your starting Shares and makes the project${wallet.passkeyFeesOn ? `, with its fees covered on ${wallet.passkeyFeesOn}` : ""}. Or connect a wallet app.` : "Connect a wallet app. It holds your starting Shares and confirms the one step that makes the project." `` |
| `Your wallet is on another network. Switch it to ${label(chainId)}.` | `Your wallet app is on another network. Switch it to ${label(chainId)}.` |

**`features/start/lib/contributor-project.ts`**

| Before | After |
|---|---|
| `"${reviewer.slice(0, 20)}" is not a wallet address (0x and 40 letters or numbers).` | `"${reviewer.slice(0, 20)}" is not an account address (0x and 40 letters or numbers).` |

**`features/start/lib/start-steps.ts`**

| Before | After |
|---|---|
| `After a raise the project becomes a DAO: owners vote on decisions, work is paid when reviewers approve it, and a public track record shows what happened.` | `After a raise the project is run by its owners: they vote on decisions, work is paid when reviewers approve it, and a public track record shows what happened.` |

**`features/start/ui/ContributorStartPage.tsx`**

| Before | After |
|---|---|
| `"Your passkey is asked once, and the fees are covered." : "Your wallet is asked once."}` | `"You confirm once with your passkey, and we cover the fees." : "Your wallet app asks you to confirm once."}` |

**`features/templates/lib/template-copy.ts`**

| Before | After |
|---|---|
| `"crypto-app-studio": "For contracts, protocols and onchain apps."` | `"crypto-app-studio": "For people building contracts and apps that run on a public network."` |

### Browsing, projects, pitches and portfolio

**`features/discover/lib/directory.ts`**

| Before | After |
|---|---|
| (nothing) | `New wording added: summoner / project setup / factory / setup helper / implementation / project template / project` |
| `sources: ["DAO creation receipt"]` | `sources: ["Project setup record"]` |
| `${deployment.role} deployment record` | `` const roleName = deploymentRoleName(deployment.role); card.sources.push( `${roleName.charAt(0).toUpperCase()}${roleName.slice(1)} contract record`, ) `` |
| `${counts.malformed} record${counts.malformed === 1 ? "" : "s"} could not be read: counted, not listed` | `${counts.malformed} record${counts.malformed === 1 ? "" : "s"} could not be read, so ${counts.malformed === 1 ? "it is" : "they are"} not listed` |
| `${counts.unlinked} deployment${counts.unlinked === 1 ? "" : "s"} name no project` | `${counts.unlinked} setup record${counts.unlinked === 1 ? "" : "s"} not linked to any project` |
| `${counts.orphanReceipts} summon receipt${counts.orphanReceipts === 1 ? "" : "s"} with no launch record on this server` | `${counts.orphanReceipts} project setup record${counts.orphanReceipts === 1 ? "" : "s"} with no matching project on this server` |

**`features/discover/ui/DiscoverCards.tsx`**

| Before | After |
|---|---|
| `import { canBackLaunch } from "@/features/discover/lib/directory"` | `import { canBackLaunch, deploymentRoleName, } from "@/features/discover/lib/directory"` |
| `link opens the block explorer` | `link opens its public page` |
| `Set up by the contributor kit` | `Set up the standard way` |
| `Not set up by the contributor kit` | `Not set up the standard way` |
| `DAO address` | `Network address` |
| `No onchain address recorded on this server yet.` | `No network address recorded on this server yet.` |
| `{card.teamSource === "equity-map" ? " · equity map" : ""} {card.teamSource === "summon-receipt" ? " · minted at summon" : ""}` | `{card.teamSource === "equity-map" ? " · from its pitch" : ""} {card.teamSource === "summon-receipt" ? " · set when the project was made" : ""}` |
| `{card.summonTx ? "Summon" : "Deployment"} tx` | `{card.summonTx ? "Setup" : "Deployment"} confirmation` |
| `Contract · ${card.contract.role}` | `Contract · ${deploymentRoleName(card.contract.role)}` |

**`features/discover/ui/DiscoverPage.tsx`**

| Before | After |
|---|---|
| `Everything on this server in one place: the DAOs that already hold money, the launches raising now, and the projects hiring for a role.` | `Everything on this server in one place: projects that already hold shared money, raises open now, and projects looking for people.` |
| `Pitches with the roles they need open. Every chip is a seat you can ask for.` | `Pitches with the roles they need. Each tag is a role you can ask to join.` |
| `Projects with their own DAO and funds.` | `A DAO is a project run by its holders' votes, with its money held in the open.` |
| `No DAOs yet. A project's DAO shows up here once it is set up.` | `No projects with shared funds yet. One shows up here once it is set up.` |

**`features/portfolio/ui/PortfolioPage.tsx`**

| Before | After |
|---|---|
| `Finish a task on your community's work board and claim it. Once a` | `Finish a task on your community's work board and submit it. Once a` |
| `Raises you back are kept in your wallet. Connect it to see them here.` | `Raises you back are kept in a wallet: an app that holds your money and proves it is you. Connect yours to see them here.` |
| `Shares are kept in your wallet. Connect it to see what you hold here.` | `{walletExplained ? "Shares are kept in the wallet you connect. Connect it to see what you hold here." : "Shares are kept in a wallet: an app that holds your money and proves it is you. Connect yours to see what you hold here."}` |
| `You don't hold Shares in any DAO from` | `You don't hold Shares in any project from` |
| `Only the {MAX_RAISES_CHECKED} newest DAOs were checked.` | `Only the {MAX_RAISES_CHECKED} newest projects were checked.` |
| `Stake CREATE to be drawn as a juror on disputes about work. Jurors who vote with the final ruling are paid.` | `Put down a deposit of CREATE, the court's deposit token, to be picked as a juror on disputes about work. Jurors who vote with the final ruling are paid.` |

**`features/projects/lib/grant.ts`**

| Before | After |
|---|---|
| `Project id "${nodeId}" is not a valid org-node id.` | `The page address "${nodeId}" is not valid. Use lowercase letters, numbers and dashes.` |
| `Role id "${role}" must be 1-12 characters of a-z, 0-9 and dashes.` | `The role name "${role}" must be 1 to 12 characters: lowercase letters, numbers and dashes.` |
| `The grantee is not a valid pubkey.` | `We could not find the account to give the stake to. Reload the page and try again.` |
| `The issuer is not a valid pubkey.` | `Your account is not ready yet. Reload the page and try again.` |

**`features/projects/lib/join-request.ts`**

| Before | After |
|---|---|
| `That is not a valid project id.` | `That is not a valid page address. Use lowercase letters, numbers and dashes.` |
| `Role id "${role}" must be 1-12 characters of a-z, 0-9 and dashes.` | `The role name "${role}" must be 1 to 12 characters: lowercase letters, numbers and dashes.` |
| `The project owner is not a pubkey.` | `We could not find the project owner's account. Reload the page and try again.` |
| `Your identity is not a pubkey yet.` | `Your account is not ready yet. Reload the page and try again.` |
| `This request's id is too long. Shorten the project id.` | `This request's ID is too long. Shorten the project's page address.` |

**`features/projects/lib/manifest.ts`**

| Before | After |
|---|---|
| `Role id "${role.slug}" must be 1-12 characters of a-z, 0-9 and dashes.` | `The role name "${role.slug}" must be 1 to 12 characters: lowercase letters, numbers and dashes.` |
| `Project id must be 1-32 characters of a-z, 0-9 and dashes.` | `Page address must be 1 to 32 characters: lowercase letters, numbers and dashes.` |

**`features/projects/ui/BoardPage.tsx`**

| Before | After |
|---|---|
| `The server did not answer the project query, so nothing can be listed.` | `The server did not answer, so no projects can be shown. Try again.` |

**`features/projects/ui/PitchDialog.tsx`**

| Before | After |
|---|---|
| `Project id` | `Page address` |

**`features/projects/ui/ProjectDetailPage.tsx`**

| Before | After |
|---|---|
| `"Recorded by an ownership grant the founder published" : "Declared by the founder's pitch, not yet a grant"` | `"Recorded: the founder approved this person's stake in the project" : "Declared in the founder's pitch. The founder has not approved it yet."` |
| `The server did not answer the project query, so this page cannot show a team map.` | `The server did not answer, so this page cannot show the team. Try again.` |
| `Approving publishes one ownership grant. The % becomes a recorded, revocable stake. Declining records the decision on the request's thread. Nothing here is a contract.` | `Approving records this share on the board as a stake you can take back. Declining records your answer on the request. Nothing here is a contract.` |

**`features/projects/use-projects.ts`**

| Before | After |
|---|---|
| `The project's org node did not publish: ${messageOf(error)}` | `"Your project could not be created. Nothing was published.", failureWords(error)` |
| `The pitch did not publish: ${messageOf(error)}` | `"Your pitch did not send.", failureWords(error)` |
| `function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }` | (nothing) |

### Community side screens: boards, moderation, wiki, repos, helpers and budgets

**`features/board/lib/starter-boards.ts`**

| Before | After |
|---|---|
| `A vote on this board shows interest. It does not decide anything: decisions that need a vote are made by the DAO, and they get their own thread here.` | `A vote on this board shows interest. It does not decide anything: decisions that need a vote are made by the project's holders, and they get their own thread here.` |

**`features/board/use-board-actions.ts`**

Also: 6 server message(s) now end with 'Try again.'.

**`features/board/use-board-members.ts`**

Also: 2 server message(s) now end with 'Try again.'.

**`features/board/use-board-moderation.ts`**

Also: 6 server message(s) now end with 'Try again.'.

**`features/board/use-board-reports.ts`**

Also: 2 server message(s) now end with 'Try again.'.

| Before | After |
|---|---|
| `The server didn't send the reports (${response.status}).` | `The server didn't send the reports. Try again in a minute.` |

**`features/board/use-my-boards.ts`**

| Before | After |
|---|---|
| `"The server didn't let you join that board." : "The server didn't let you leave that board."` | `"The server didn't let you join that board. Try again." : "The server didn't let you leave that board. Try again."` |

**`features/board/use-post-to-board.ts`**

Also: 1 server message(s) now end with 'Try again.'.

**`features/board/use-starter-boards.ts`**

Also: 1 server message(s) now end with 'Try again.'.

**`features/budgets/lib/budgetForm.ts`**

Also: 3 wording tweak(s) of spelling, punctuation or capitalization only.

| Before | After |
|---|---|
| `A budget covers an agent (its 64-hex public key) or all agents ("*"). An org node id is not a valid subject.` | `A budget covers one agent (use its 64-character public key) or all agents (use *). A team name does not work here.` |
| `onchain: "Enforced onchain", advisory: "Advisory"` | `onchain: "Enforced by the network", advisory: "Not enforced"` |
| `Max LLM Calls` | `Max AI calls` |
| `Max LLM Spend (cents)` | `Max AI spend (cents)` |
| `Dollar-denominated LLM budget in cents. Needs the server's LLM prices configured; without them the gateway refuses the agent rather than run it unmetered.` | `A dollar limit on AI use, in cents. The server needs the AI prices set up. Without them it stops the helper instead of letting it run uncounted.` |
| `Task Create Limit` | `Max tasks created` |
| `Task Approve Limit` | `Max tasks approved` |
| `Max Spend (cents)` | `Max spending (cents)` |
| `Only an on-chain allowance can stop spending.` | `Only a spending limit built into the contract can stop spending.` |
| (nothing) | `New wording added: require-approval / the agent has to ask for approval first / reject / the agent is stopped` |
| `` rows.push(["llmCalls", `${limits.llmCalls} LLM calls/${window}`, "relay"]) `` | `` rows.push(["llmCalls", `${limits.llmCalls} AI calls/${window}`, "relay"]) `` |
| `${limits.llmCostCents}¢ LLM spend/${window}` | `${limits.llmCostCents}¢ AI spend/${window}` |

**`features/budgets/ui/BudgetAuthorForm.tsx`**

| Before | After |
|---|---|
| `Cap an agent’s runs, messages, or spend. Each limit says plainly whether the server enforces it or it is only advisory.` | `Cap what an agent can run, send or spend. Each limit says whether the server enforces it or it is only a note.` |
| `Covers agent (64-hex public key, or * for all agents)` | `Covers agent (its 64-character public key, or * for all agents)` |
| `on exceed: {budget.onExceed}` | `If a limit is passed, {describeOnExceed(budget.onExceed)}.` |

**`features/budgets/use-budgets.ts`**

| Before | After |
|---|---|
| `The server did not answer the budget query. Check the connection, then retry.` | `The server did not answer, so the budgets can't be shown. Check your connection, then try again.` |

**`features/fleet/escalate-post.ts`**

Also: 1 server message(s) now end with 'Try again.'.

**`features/fleet/lib/agentStopFlow.ts`**

Also: 1 server message(s) now end with 'Try again.'.

**`features/fleet/ui/AgentStopDialog.tsx`**

| Before | After |
|---|---|
| `Setting the stop budget` | `Setting its budget to zero` |
| `Revoking its permissions` | `Taking away its permissions` |
| `{names} will be stopped: no budget, no permissions, and removed from its seats.` | `{names} will be stopped: it gets no budget, loses its permissions and is taken off its seats.` |

**`features/fleet/ui/FleetView.tsx`**

| Before | After |
|---|---|
| `This tab agent · usage` | `This tab's helper · usage` |
| `<p>prompt tk</p>` | `<p>tokens in</p>` |
| `<p>output tk</p>` | `<p> tokens out </p>` |
| `Reset ledger` | `Reset counts` |
| `The server did not answer the task query, so no tasks can be listed.` | `The server did not answer, so the tasks can't be shown.` |

**`features/fleet/ui/OrgSetup.tsx`**

| Before | After |
|---|---|
| `open a project's page to give the team a treasury and a vote.` | `open a project's page to give the team shared money and a vote.` |

**`features/fleet/ui/OrgView.tsx`**

| Before | After |
|---|---|
| `Loading org chart…` | `Loading the team chart…` |

**`features/fleet/ui/ProjectAgents.tsx`**

| Before | After |
|---|---|
| `See project work and the founder-managed community helper seats. Seats belong to the community; only team-signed tasks count as project work here. Other participants’ updates remain on the workspace board.` | `See the project's work and the helper seats its founders manage. Seats belong to the whole community. Only tasks the team created count as project work here. Other people's updates stay on the workspace board.` |
| `A seat or task assignment does not grant wallet authority. Budget controls distinguish recorded limits from enforced limits. Usage in AI` | `A seat or a task does not let a helper move any money. Each limit says whether it is only written down or actually enforced. Usage in AI` |
| `Some agent, role or work records could not be read. Keep unknown activity and authority unverified.` | `Some helper, role or work records could not be loaded. Treat anything missing here as unconfirmed.` |
| `Reload records` | `Reload the records` |
| `<p>Reading agents and assigned work…</p>` | `<p>Loading helpers and their work…</p>` |
| `No announced helpers are linked to this project's seats or tasks yet. Open role management to give a helper a seat.` | `No helpers that have announced themselves are linked to this project's seats or tasks yet. Open role management to give a helper a seat.` |
| `No recent heartbeat` | `Not seen recently` |
| `Assigned work here; no project-authored seat was found.` | `Has work here; no seat from this project was found.` |
| `<p>Reading limits…</p>` | `<p>Loading limits…</p>` |
| `Could not read limits.` | `Could not load the limits.` |
| `Retry budgets` | `Reload the limits` |
| `Onchain binding recorded; allowance not verified here` | `A limit on the network is recorded; not checked here` |
| `No applicable limit found in the latest budget records. This does not establish unlimited authority.` | `No limit found in the latest budget records. That does not mean there is no limit.` |
| `These are recorded limits, not measured spending or a live allowance balance.` | `These are the limits that were recorded, not what has been spent or what is left.` |
| `Announced tools and recorded role scope` | `Tools it announced and what its seat covers` |
| `No project-authored role scope recorded.` | `The project has not recorded what this seat covers.` |

**`features/fleet/ui/TaskDeliveryPanel.tsx`**

| Before | After |
|---|---|
| `Use an http or https link for the output.` | `Use a web link that starts with http or https.` |
| `This project could not be found. Retry the project read or choose another project.` | `This project could not be found. Reload the projects or choose another one.` |
| `Choose a project for these delivery references.` | `Choose a project for these delivery links.` |
| `Read the project's claims before linking one.` | `Load the project's submissions before linking one.` |
| `Link the project, its output and an existing funding claim. Finishing or approving this task never sends money. A reference does not establish that a claim was filed for this task or approved by the project.` | `Link the project, its output and an existing submission. Finishing or approving this task never sends money. A link does not prove that a submission was made for this task or approved by the project.` |
| `Onchain claim` | `Submission recorded on the network` |
| `<option value="">No linked claim</option>` | `<option value="">No linked submission</option>` |
| `Previously linked claim (not read yet)` | `Linked earlier (not loaded yet)` |
| `Select this project's network (${launch.record.chainId ?? "unknown"}) to read its claims.` | `Switch to this project's network (${launch.record.chainId ?? "unknown"}) to load its submissions.` |
| `Retry claim read` | `Reload submissions` |
| `Read from the chain: {claimStatusLabel(selected.claim.record)} · filed by {walletLabel(selected.claim.record.contributor)}. Review and payment remain separate actions.` | `Read from the network: {claimStatusLabel(selected.claim.record)} · submitted by {walletLabel(selected.claim.record.contributor)}. Review and payment are separate steps.` |
| `{claimStatusLabel(c.claim.record)} · claim` | `{claimStatusLabel(c.claim.record)} · submission` |

**`features/fleet/ui/WorkBoard.tsx`**

| Before | After |
|---|---|
| `The server did not answer the task and issue query, so this board has nothing to show.` | `The server did not answer, so this board has nothing to show.` |

**`features/fleet/use-tab-helper.ts`**

Also: 1 server message(s) now end with 'Try again.'.

**`features/fleet/use-task-planning.ts`**

| Before | After |
|---|---|
| `await publishAsUser(template, "The server refused this change.")` | `await publishAsUser( template, "The server did not accept this change. Try again.", )` |

**`features/moderation/lib/escalatedReports.ts`**

| Before | After |
|---|---|
| `The server didn’t accept you as one of the people who run it. Sign in with that key and try again.` | `The server doesn’t list you as one of the people who run it. Sign in with the account that runs the server, then try again.` |

**`features/moderation/lib/moderationQueue.ts`**

| Before | After |
|---|---|
| `illegal: "Illegal content", nudity: "Nudity", malware: "Malware", spam: "Spam", impersonation: "Impersonation", profanity: "Profanity", other: "Other"` | `illegal: "Something illegal", nudity: "Sexual content", malware: "A harmful link or file", spam: "Spam or a scam", impersonation: "Pretending to be someone else", profanity: "Abuse or hateful language", other: "Something else"` |
| `return REPORT_TYPE_LABEL[reportType] ?? "Other"` | `return REPORT_TYPE_LABEL[reportType] ?? "Something else"` |

**`features/moderation/use-moderation-queue.ts`**

| Before | After |
|---|---|
| `await publishAsUser(template, "The server rejected the action.")` | `await publishAsUser( template, "The server did not accept the action. Try again.", )` |
| `Couldn’t resolve who to time out.` | `Couldn’t tell who wrote this, so they can’t be muted here. The report is still open.` |
| `Couldn’t resolve who to ban.` | `Couldn’t tell who wrote this, so they can’t be banned here. The report is still open.` |

**`features/repos/lib/repo-refs.ts`**

| Before | After |
|---|---|
| `This server doesn't say which key it signs its code records with, so its branches and tags can't be shown safely. Ask whoever runs the server to give it a permanent signing key, then try again.` | `This server doesn't say which signing key it uses for its code records, so its branches and tags can't be shown safely. Ask whoever runs the server to set a permanent signing key, then try again.` |

**`features/repos/ui/RepoBlobViewer.tsx`**

| Before | After |
|---|---|
| `Sandboxed preview. The page's own scripts do not run here: the document's Content-Security-Policy applies to this frame, and relaxing it would also relax it for the app. Static content, styles and inlined assets render.` | `Preview only. This page's scripts do not run here, so buttons and animations may not work. Text, styles and images show as they will.` |
| `Binary file: {formatBytes(view.sizeBytes)}. Use the Download button above to save it.` | `This file can't be shown as text ({formatBytes(view.sizeBytes)}). Use the Download button above to save it.` |

**`features/repos/ui/RepoDetailPage.tsx`**

| Before | After |
|---|---|
| `aria-label="Copy clone URL"` | `aria-label="Copy download address"` |

**`features/repos/ui/ReposPage.tsx`**

| Before | After |
|---|---|
| `That doesn't look like a server address. It should look like wss://community.example.com.` | `That doesn't look like a server address. It should look like community.example.com.` |
| `The server didn't answer when asked for this community's code.` | `The server didn't answer, so this community's code can't be shown.` |
| `wss://community.example.com` | `community.example.com` |

**`features/wiki/lib/live-status.ts`**

| Before | After |
|---|---|
| `` "no-identity": `Live co-editing is unavailable: it needs a signed-in identity to prove you are a community member. ${SAVE_FALLBACK}`, "no-member-list": `Live co-editing is unavailable: this server publishes no member list, so collaborators cannot be verified. ${SAVE_FALLBACK}` `` | `` "no-identity": `Live co-editing is unavailable: you need to be signed in with an account so the page can tell you are a community member. ${SAVE_FALLBACK}`, "no-member-list": `Live co-editing is unavailable: this server publishes no member list, so we cannot tell who is a member. ${SAVE_FALLBACK}` `` |
| `` "not-member": `Live co-editing is unavailable: it is limited to verified community members and this identity is not one. ${SAVE_FALLBACK}`, "room-failed": `Live co-editing is unavailable: the peer-to-peer room could not be opened. ${SAVE_FALLBACK}`, "cannot-sign": `Live co-editing is unavailable: your identity could not sign the update (unlock your passkey or approve the signing request). ${SAVE_FALLBACK}` `` | `` "not-member": `Live co-editing is unavailable: it is limited to verified community members and this account is not one. ${SAVE_FALLBACK}`, "room-failed": `Live co-editing is unavailable: the shared editing session could not be started. Reopen the page to try again. ${SAVE_FALLBACK}`, "cannot-sign": `Live co-editing is unavailable: your changes could not be confirmed with your account. Unlock your passkey or approve the request, then reopen the page. ${SAVE_FALLBACK}` `` |
| `${counts.strangers} unverified ${counts.strangers === 1 ? "peer is" : "peers are"} in the room and receive nothing.` | `${counts.strangers} ${counts.strangers === 1 ? "person who is not a confirmed member is" : "people who are not confirmed members are"} connected to this page and ${counts.strangers === 1 ? "gets" : "get"} none of your changes.` |
| `${counts.rejected} received ${counts.rejected === 1 ? "update was" : "updates were"} ignored (unsigned, invalid, or not from a member).` | `${counts.rejected} ${counts.rejected === 1 ? "change" : "changes"} from others ${counts.rejected === 1 ? "was" : "were"} ignored (not confirmed, not valid, or not from a member).` |
| `${counts.peers} other verified ${counts.peers === 1 ? "member is" : "members are"} connected. Only signed updates from community members are applied.${suffix}` | `${counts.peers} other verified ${counts.peers === 1 ? "member is" : "members are"} connected. Only changes confirmed as coming from community members are applied.${suffix}` |

**`features/wiki/ui/RecentlyDeleted.tsx`**

| Before | After |
|---|---|
| `The server did not answer the deleted-pages query, so the list is unknown.` | `The server did not answer, so the list of deleted pages can't be shown.` |

**`features/wiki/ui/ScopeEditor.tsx`**

| Before | After |
|---|---|
| `aria-label={conflicting ? "Settle scope" : "Change scope"}` | `aria-label={conflicting ? "Choose team" : "Change team"}` |
| `{conflicting ? "Settle scope" : "Page scope"}` | `{conflicting ? "Choose team" : "Who can edit"}` |
| `Team this page is scoped to` | `Team that can edit this page` |
| `Save scope` | `Save team` |

**`features/wiki/ui/WikiGraph.tsx`**

| Before | After |
|---|---|
| `{nodes.size} nodes · {edges.size} links · from [[wiki links]] and #tags` | `{nodes.size} items · {edges.size} links · built from [[page links]] and #tags` |
| `aria-label="Wiki knowledge graph: pages and links between them"` | `aria-label="Map of wiki pages and the links between them"` |

**`features/wiki/ui/WikiView.tsx`**

| Before | After |
|---|---|
| `The server did not answer the wiki page query, so there is no known list of pages.` | `The server did not answer, so the list of pages can't be shown.` |
| `aria-label="Export wiki as markdown"` | `aria-label="Export all wiki pages"` |
| `Download all pages as one markdown file` | `Download all pages as one file` |
| `"Settle this page's team scope" : "Change this page's team scope"` | `"Choose which team can edit this page" : "Change which team can edit this page"` |
| `{conflicting ? "Settle scope" : "Change scope"}` | `{conflicting ? "Choose team" : "Change team"}` |
| `Page scope saved` | `Saved: which team can edit this page` |
| `toast.error("Couldn't save the page scope", {` | `toast.error("Couldn't save which team can edit", {` |
| `This page's history disagrees about its team scope. An admin needs to settle it before anyone can edit.` | `The records disagree about which team can edit this page. An admin needs to choose one before anyone can edit.` |
| `Write in markdown. [[Other Page]] links create the graph.` | `Write here. Put a page name in double square brackets, like [[Other Page]], to link to it.` |
| `Pages are addressable by name, so the name is permanent until you rename the page.` | `Links to a page use its name, so the name stays the same until you rename the page.` |

**`features/wiki/use-knowledge.ts`**

| Before | After |
|---|---|
| `Server rejected the restore` | `throw new Error( result.message ?? "The server did not accept the restore. Try again.", )` |
| `Server rejected the suggestion` | `The server did not accept the suggestion. Try again.` |

**`features/wiki/use-wiki-pages.ts`**

| Before | After |
|---|---|
| `Server rejected the wiki page` | `throw new Error( result.message ?? "The server did not accept the page. Try again.", )` |
| `Server rejected the delete` | `throw new Error( result.message ?? "The server did not accept the delete. Try again.", )` |
| `Server rejected the restore` | `The server did not accept the restore. Try again.` |

**`features/workflows/use-workflow-runs.ts`**

| Before | After |
|---|---|
| `await publishAsUser(template, "The server rejected the change.")` | `await publishAsUser( template, "The server did not accept the change. Try again.", )` |

### Money: funding, the project's money, payouts, leaving and bonds

**`features/launchpad/lib/agreement-next.ts`**

Also: 1 wording tweak(s) of spelling, punctuation or capitalization only.

**`features/launchpad/lib/exit-flow.ts`**

| Before | After |
|---|---|
| `the transaction failed onchain (tx ${receipt.txHash})` | `the step failed on the network (confirmation ID ${receipt.txHash})` |
| `the outcome of transaction ${receipt.txHash} is still unknown. Check whether it landed before retrying` | `the outcome of the step with confirmation ID ${receipt.txHash} is still unknown. Check whether it went through before trying again` |

**`features/launchpad/lib/fund-flow.ts`**

| Before | After |
|---|---|
| `the auction did not report a funds recipient, so it is not managed by a GraduationExecutor` | `the sale did not say where its money goes, so it does not use the standard payout step` |
| `the auction did not answer currency()` | `the sale did not say which currency it raised in` |
| `the executor did not report a treasury address. Check that the auction's funds recipient is a GraduationExecutor` | `the payout step did not say where the project's money goes. Check that the sale uses the standard payout step` |
| `fund-flow: ${message}` | `throw new Error(message)` |
| `could not read ${currency} balance of ${holder}` | `could not read the balance held by ${holder}` |

**`features/launchpad/lib/funding-copy.ts`**

| Before | After |
|---|---|
| `This project's team has no milestone locks.` | `None of the team's Shares are locked behind milestones.` |
| `You get non-voting shares: the same part of the treasury and payouts as a Share, but no vote. For now you can leave with them at any time; selling them to a new buyer in a round comes later.` | `You get non-voting shares: the same part of the project's money and payouts as a Share, but no vote. For now you can leave with them at any time; selling them to a new buyer in a round comes later.` |
| `Leaving keeps ${feePercent(view.exitFeeBps)} of what it pays in the treasury, for those who stay. It is not charged while the terms are under notice, and a vote can lower it but never raise it.` | `Of what leaving pays, ${feePercent(view.exitFeeBps)} stays with the project, for those who stay. It is not charged while the terms are under notice, and a vote can lower it but never raise it.` |

**`features/launchpad/lib/funding.ts`**

| Before | After |
|---|---|
| `Sell a fixed tranche to the highest bidders over a set window.` | `Sell a fixed batch to the highest bidders over a set period.` |

**`features/launchpad/lib/money-in.ts`**

| Before | After |
|---|---|
| `Nothing has been paid into the treasury besides the raise yet.` | `Apart from the money raised, nothing has been paid in yet.` |
| `Besides the raise, ${money(summary.paidInTotal)} was paid into the treasury in ${count} payment${count === 1 ? "" : "s"}.` | `Apart from the money raised, ${money(summary.paidInTotal)} was paid in, in ${count} payment${count === 1 ? "" : "s"}.` |

**`features/launchpad/lib/ragequit-flow.ts`**

| Before | After |
|---|---|
| `no confirmed exit to record` | `there is no confirmed exit to record` |
| `${errorMessage(err)}. The exit itself landed (tx ${record.txHash}); retrying records it without sending again.` | `${errorMessage(err)}. The exit itself went through (confirmation ID ${record.txHash}); trying again only saves the record and does not send the exit again.` |

**`features/launchpad/lib/revenue-pledge.ts`**

| Before | After |
|---|---|
| `The team pledges ${pledge.percent}% of the project's net receipts to the treasury, every ${pledge.every}, ${until}. ${where} The contracts do not enforce it.` | `The team pledges ${pledge.percent}% of the project's net receipts, to be paid into the project's money every ${pledge.every}, ${until}. ${where} The contracts do not enforce it.` |

**`features/launchpad/lib/send-money.ts`**

| Before | After |
|---|---|
| `Paste the full address to send to: 0x and 40 letters or numbers.` | `Paste the full account address to send to. It starts with 0x, then 40 letters or numbers.` |
| `That is this account's own address. Paste the address you want the money to go to.` | `That is this account's own address. Paste the account address you want the money to go to.` |
| `if (amount <= 0n) return { problem: "Send more than nothing." }` | `if (amount <= 0n) return { problem: "Enter an amount above zero." }` |

**`features/launchpad/lib/time-blocks.ts`**

| Before | After |
|---|---|
| `` `a block every ${roundReadable(plan.secondsPerBlock)}s on this chain` : `this chain's default of a block every ${roundReadable(plan.secondsPerBlock)}s (the chain could not be read)`; return `That's ≈ ${plan.windowBlocks.toLocaleString("en-US")} blocks for ${duration} at ${source}. The app rounds ${plan.marginBlocks.toLocaleString("en-US")} blocks longer than asked so a slow chain can't close the sale early.` `` | `` "how fast the network is running now" : "the network's usual pace (we could not read its current pace)"; return `The sale will run for about ${duration}, going by ${source}. The app adds a small margin so a slow network cannot end the sale early.` `` |

**`features/launchpad/lib/wallet-effects.ts`**

| Before | After |
|---|---|
| `Your wallet is on chain ${actual}, but this launch is on chain ${chainId}. Switch networks in your wallet and try again.` | `Your wallet is on ${networkLabel(actual)}, but this project is on ${networkLabel(chainId)}. Switch networks in your wallet, then try again.` |
| `Transaction ${hash} was sent but not confirmed within ${Math.round(timeoutMs / 1000)}s. Check your wallet or a block explorer; if it landed, retry and this step will detect it.` | `Your step (confirmation ID ${hash}) was sent but not confirmed within ${Math.round(timeoutMs / 1000)}s. It may still go through, so money may still move. Check your wallet before trying again. If it went through, try again and this step will notice.` |

**`features/launchpad/lib/wallet-sender.ts`**

| Before | After |
|---|---|
| `No wallet found in this browser. Bid on the auction contract directly, then paste the transaction hash below.` | `No wallet found in this browser. Bid on the sale's contract directly, then paste its confirmation ID below.` |

**`features/launchpad/ui/AccountMoneyCard.tsx`**

| Before | After |
|---|---|
| `Send to (an address)` | `Send to (account address)` |

**`features/launchpad/ui/AccountStrip.tsx`**

| Before | After |
|---|---|
| `To take part here you need a wallet in this browser. Add one, then reload this page.` | `To take part here you need a wallet in this browser: an app that holds your money and proves it is you. Add one, then reload this page.` |
| `To take part, sign in with a passkey. You need no wallet` | `To take part, sign in with a passkey (your fingerprint, face or device PIN). You need no wallet` |

**`features/launchpad/ui/AllowanceNote.tsx`**

| Before | After |
|---|---|
| `Couldn't read this year's allowance of new Shares from the network. The Shares still refuse an award over it, so check again before proposing one.` | `Couldn't read this year's limit on new Shares from the network. The Shares still refuse an award over the limit, so check again before proposing one.` |

**`features/launchpad/ui/BondReturn.tsx`**

| Before | After |
|---|---|
| `stops counting at once, so you cannot judge work until you post it again, and it stays at risk for 14 days after you ask.` | `stops counting at once, so you cannot judge work until you put it down again, and it stays at risk for 14 days after you ask.` |

**`features/launchpad/ui/BudgetFigures.tsx`**

| Before | After |
|---|---|
| `" · bond posted" : " · bond not posted yet"` | `" · bond put down" : " · bond not put down yet"` |
| `${bondMoney(mandate.bond.minBond)} each, which the DAO can take after a disputed approval` | `${bondMoney(mandate.bond.minBond)} each, which the project can take after a disputed approval` |
| (nothing) | `New wording added: work-bond-help` |

**`features/launchpad/ui/ContributorFundsTab.tsx`**

| Before | After |
|---|---|
| `"Checking this project's DAO…" : "This project's DAO could not be checked against the contributor kit, so its money and the way to leave are not shown here."}` | `"Checking this project's setup…" : "This project's setup could not be checked against the standard way projects are made, so its money and the way to leave are not shown here."}` |
| `Anyone can send {usdc ? "USDC or ETH" : "ETH"} to its DAO, on {plainNetworkName(chainId)} only. Money sent on another network is lost.` | `Anyone can send {usdc ? "USDC or ETH" : "ETH"} to the project's address, on {plainNetworkName(chainId)} only. Money sent on another network is lost.` |
| `copyLabel="Copy the DAO's address" label="The DAO's address"` | `copyLabel="Copy the project's address" label="The project's address"` |

**`features/launchpad/ui/ContributorSettings.tsx`**

| Before | After |
|---|---|
| `The project stops being listed. Its DAO, its Shares and everything already decided stay on the network.` | `The project stops being listed. The project itself, its Shares and everything already decided stay on the network.` |

**`features/launchpad/ui/DaoTreasuryTab.tsx`**

| Before | After |
|---|---|
| `The money this project raised sits in its DAO. Holders decide what it is spent on, on the Decisions tab, and anyone holding Shares can leave with their share of what is left.` | `The money the project holds together. What it raised is held by the project itself. Holders decide on the Decisions tab what it is spent on, and anyone holding Shares can leave with their share of what is left.` |

**`features/launchpad/ui/FundingCard.tsx`**

| Before | After |
|---|---|
| `Holders vote funding terms first: whether buyers get non-voting shares (no vote) or Shares, a funding limit, an exit fee of at most 5%, and the one rounds contract that may sell. Nothing sells until 30 days later, and leaving costs no fee until then, so anyone who disagrees can leave whole. After that the fee's part of what leaving pays stays in the treasury, for those who stay. Each sale is then its own vote, with a quantity, a least price and an end date, and is sold in weekly funding rounds: bids set the price, never below a share's part of the treasury plus 2%, and nothing sells while the treasury holds ETH or a token on its watch list, which any holder can add to. Settling a round creates the shares sold and pays the treasury at once.` | `Holders first vote on the funding terms: whether buyers get non-voting shares (no vote) or Shares, a funding limit, an exit fee of at most 5%, and the one rounds contract that may run the sales. Nothing sells until 30 days later, and leaving costs no fee until then, so anyone who disagrees can leave whole. After that, the exit fee part of what leaving pays stays in the project's money, for those who stay. Each sale is then its own vote, with a quantity, a least price and an end date, and is sold in weekly funding rounds. Bids set the price, never below a share's part of the project's money plus 2%. Nothing sells while the project holds ETH or a token on its watch list, and any holder can add to that list. Settling a round works out the price and who gets what, creates the shares sold and pays the sale money into the project at once.` |

**`features/launchpad/ui/FundingFlagForm.tsx`**

| Before | After |
|---|---|
| `Does the treasury hold another token?` | `Does the project's money include another token?` |
| `Sale prices count only USDC, so if the treasury holds another token` | `Sale prices count only USDC, so if the project holds another token` |
| `` "No other token is watched yet; ETH always is." : `Watched besides ETH: ${watched.join(", ")}.`} `` | `` "No other token is on the watch list yet; ETH always is." : `On the watch list besides ETH: ${watched.join(", ")}.`} `` |
| `sales while the treasury holds it; only a vote can let them go ahead.` | `sales while the project holds it; only a vote can let them go ahead.` |

**`features/launchpad/ui/GraduationPanel.tsx`**

| Before | After |
|---|---|
| ` The graduation itself is complete onchain. Retrying only publishes the remaining receipt and never sends the money again.` | ` The payout itself is complete. Trying again only saves the remaining record and never sends the money again.` |
| `Enter the full transaction hash: 0x followed by 64 hexadecimal characters.` | `Enter the full confirmation ID: 0x followed by 64 letters or numbers (0-9, a-f).` |
| `Graduate the launch` | `Pay out the sale` |
| `` "Once the auction has ended and raised enough, one transaction sweeps the raise and the unsold supply to the DAO's treasury and records the graduation. Anyone can send it; the money can only go there." : `Once the auction has ended and raised enough, one transaction sweeps the raise and the unsold supply, puts ${DEFAULT_RESERVE_BPS / 100}% of the raise into the reserve escrow that backs the token's price floor, sends the rest to the treasury, and records the graduation. Anyone can send it; the money can only go to those two places.`} `` | `` "Paying out the sale (its technical name is graduation) comes once the sale has ended and raised enough: one step moves the money raised and the unsold tokens to the project's money and records it. Anyone can run it; the money can only go there." : `Paying out the sale (its technical name is graduation) comes once the sale has ended and raised enough: one step moves the money raised and the unsold tokens, sets ${DEFAULT_RESERVE_BPS / 100}% of the raise aside to back the token's price floor, sends the rest to the project's money, and records it. Anyone can run it; the money can only go to those two places.`} `` |
| `Reading the auction's graduation gates…` | `Checking whether the sale can be paid out…` |
| `Paid to the treasury` | `Paid to the project's money` |
| `Held in reserve for the price floor` | `Set aside for the price floor` |
| `Unsold tokens returned to the treasury` | `Unsold tokens returned to the project` |
| `aria-label="Graduation steps"` | `aria-label="Payout steps"` |
| `Execute graduation` | `Pay out the sale` |
| `Re-check readiness` | `Check readiness again` |
| `"Retry receipt publish" : "Retry remaining steps"}` | `"Save the record again" : "Try the remaining steps again"}` |
| `aria-label="Supply the graduation transaction hash"` | `aria-label="Enter the confirmation ID of the payout"` |
| `Graduation transaction hash` | `Confirmation ID of the payout` |
| `Resume receipt publish` | `Save the record` |
| `Graduation in progress…` | `Paying out the sale…` |
| `Graduation executed and both receipts published.` | `The sale is paid out and both records are saved.` |
| `copyLabel="Copy graduation executor address" label="Graduation executor (the auction's funds recipient)"` | `copyLabel="Copy payout step address" label="Payout step (where the sale's money goes first)"` |
| `copyLabel="Copy graduation transaction hash" label="Graduation transaction"` | `copyLabel="Copy payout confirmation ID" label="Payout confirmation ID"` |

**`features/launchpad/ui/MoneyInCard.tsx`**

| Before | After |
|---|---|
| `"The team has not pledged any of what the project earns to the treasury."} What is paid in stays in the treasury, where every holder can leave with their part of it.` | `"The team has not pledged to pay in any of what the project earns."} What is paid in stays in the project's money, where every holder can leave with their part of it.` |
| `Couldn't tell what came into the treasury just now: looking up where the raise and the bonds came from did not work, and without that the raise could look like extra payments. Nothing is shown until it can be read.` | `Couldn't work out what money came in just now. We could not look up where the raise and the bonds came from, and without that the raise could look like extra payments. Nothing is shown until it can be read.` |

**`features/launchpad/ui/OverviewTab.tsx`**

| Before | After |
|---|---|
| `Threshold met` | `Minimum reached` |
| `${truncatePubkey(cur.value)} (ERC-20)` | `${truncatePubkey(cur.value)} (custom token)` |
| `Claims open` | `Collection opens` |
| `` `Block ${record.claimBlock}${ record.endBlock ? ` · ${formatBlocks(record.claimBlock - record.endBlock)} after the close` : "" }` `` | `` record.endBlock ? `${formatBlocks(record.claimBlock - record.endBlock)} after the sale closes` : "After the sale closes" `` |
| `We couldn't read the blockchain, so live figures are hidden.` | `We couldn't reach the network, so live figures are hidden.` |
| `Chain RPC endpoint` | `Network connection address` |
| `Use this endpoint` | `Use this address` |
| (nothing) | `` <div> <dt> Sale window (block numbers) </dt> <dd> {record.startBlock && record.endBlock ? `${record.startBlock} → ${record.endBlock}` : "—"} </dd> </div> <div> <dt> Collection opens (block number) </dt> <dd>{record.claimBlock \|\| "—"}</dd> </div> `` |
| `["Treasury contract", chainState.treasury ?? "checking…"]` | `["Project money contract", chainState.treasury ?? "checking…"]` |
| `Vesting package` | `Unlock schedule` |
| `${record.vesting.tranches.length} tranches from ${record.vesting.tranches[0].multiple}x` | `${record.vesting.tranches.length} parts from ${record.vesting.tranches[0].multiple}x` |
| `Bound channels` | `Linked channels` |
| `` `${record.channels.length} bound` : "none bound" `` | `` `${record.channels.length} linked` : "none linked" `` |
| `Team keys` | `Team accounts` |
| `Parameter hash` | `Settings ID` |
| `${formatBlocks(record.endBlock - record.startBlock)} (blocks ${record.startBlock} → ${record.endBlock})` | `formatBlocks(record.endBlock - record.startBlock)` |
| `<dt>Chain</dt>` | `<dt>Network</dt>` |

**`features/launchpad/ui/PanelUnreadableNote.tsx`**

| Before | After |
|---|---|
| `Couldn't read which of this DAO's budgets is the milestone panel, so the cards below may show it as an ordinary budget. Reload to try again.` | `Couldn't read which of this project's work budgets holds the milestone reviewers, so the cards below may show it as an ordinary budget. Reload to try again.` |

**`features/launchpad/ui/PayoutsCard.tsx`**

| Before | After |
|---|---|
| `Revenue sent to` | `Revenue sent to the payout address` |
| `non-voting shares they hold, the rest to the treasury.` | `non-voting shares they hold, the rest to the project's money.` |
| `Holders count from when they hold, keep what was paid to them after they sell or leave, and collect it themselves. Test money only.` | `A holder counts from the moment they hold, keeps what was paid to them after they sell or leave, and collects it themselves. Test money only.` |

**`features/launchpad/ui/PayoutsForm.tsx`**

| Before | After |
|---|---|
| `Working out the module's address…` | `Working out the payout address…` |
| `The rest of each payment goes to the treasury. Changing it later takes a vote and 30 days' notice.` | `The rest of each payment goes to the project's money. Changing it later takes a vote and 30 days' notice.` |
| `Taken from the treasury now and shared by everyone holding Shares or non-voting shares, by how many they hold.` | `Taken from the project's money now and shared among everyone holding Shares or non-voting shares, in proportion to what they hold.` |

**`features/launchpad/ui/RagequitPanel.tsx`**

| Before | After |
|---|---|
| `The treasury holds {formatTokenAmount(pool, info)}` | `The project holds {formatTokenAmount(pool, info)}` |
| `There is no DAO for this project yet, so there is nothing to leave. This opens once the sale ends and the DAO starts.` | `This project has no shared money to leave yet. This opens once the sale ends and the project is set up.` |
| `DAO {truncatePubkey(daoBinding.dao)}.` | `Project address {truncatePubkey(daoBinding.dao)}.` |
| `Nobody outside the DAO holds shares yet, so there is nothing to take back.` | `Nobody but the project itself holds shares yet, so there is nothing to take back.` |
| `This DAO is not letting members leave right now, so there is nothing you need to do.` | `This project is not letting members leave right now, so there is nothing you need to do.` |
| `This app can't tell what leaving would pay. This DAO's exit asks its milestone lock how many Shares are still locked, and the lock is older than the DAO and cannot answer, so the chain would refuse the exit. Your Shares are unchanged.` | `This app can't tell what leaving would pay. To work it out, the project's exit needs to know how many Shares are still locked behind milestones. The milestone lock is older than the project and cannot say, so the network would refuse the exit. Your Shares are unchanged.` |
| `Shares the treasury is shared among` | `Shares the project's money is shared among` |
| `stays in the treasury, for those who stay. The amounts below are what` | `stays with the project, for those who stay. The amounts below are what` |
| `This DAO was made before Shares still locked behind milestones were left out of an exit, so its exit still counts them: your part is worked out over every Share outside the DAO, locked ones included.` | `This project was made before Shares still locked behind milestones were left out of an exit, so its exit still counts them: your part is worked out over every Share that is not the project's own, locked ones included.` |
| `The treasury holds nothing to take back right now.` | `The project holds no money to take back right now.` |
| `This is worked out from the treasury as it is now. The exact amount is fixed when the exit goes through.` | `This is worked out from the project's money as it is now. The exact amount is fixed when the exit goes through.` |
| `your exit went through, but its transaction is not known here, so no record of it was saved` | `your exit went through, but its confirmation ID is not known here, so no record of it was saved` |
| `The treasury holds nothing you can take, so leaving now pays you` | `The project holds nothing you can take, so leaving now pays you` |
| `. Anything else the DAO holds stays in the treasury.` | `. Anything else the project holds stays with the project.` |
| `The exit transaction:` | `Confirmation ID of the exit:` |
| `(tx` | `(confirmation ID` |
| `, and the receipt is recorded.` | `, and a record of it is saved.` |
| `{exitLanded ? "Retry the record" : "Retry"}` | `{exitLanded ? "Save the record again" : "Retry"}` |
| `Your Shares are a claim on what the treasury holds. If you want out, you can give them up and take your part of it. Shares the DAO keeps for itself do not count, so they never shrink what you get. Leaving pays your part of what the treasury holds now; it does not protect your share of the project itself.` | `Your Shares are a claim on the project's money. If you want out, you can give them up and take your part of it. Shares the project keeps for itself do not count, so they never shrink what you get. Leaving pays your part of the money the project holds now; it does not protect your share of the project itself.` |

**`features/launchpad/ui/RevenuePledgeCard.tsx`**

| Before | After |
|---|---|
| `The signed document the pledge is written into, for example the operating agreement of the entity that holds the IP.` | `The signed document the pledge is written into, for example the operating agreement of the legal entity that holds the project's intellectual property (IP).` |
| `You have not pledged any of what the project earns to the treasury. A pledge is how revenue reaches holders here: money paid in raises every Share's part of the treasury.` | `"You have not pledged to pay in any of what the project earns. A pledge is how revenue reaches holders here: money paid in raises every Share's part of the project's money."} </p> <p> Net receipts means what is left of the project's income after its costs.` |
| `treasury, where every holder can leave with their part of it.` | `project's money, where every holder can leave with their part of it.` |

**`features/launchpad/ui/RunwayCard.tsx`**

| Before | After |
|---|---|
| `In the treasury` | `Held by the project` |

**`features/launchpad/ui/SenderPicker.tsx`**

| Before | After |
|---|---|
| `Could not derive the account.` | `Could not work out the account.` |
| `Deriving the account address…` | `Working out the account address…` |

**`features/launchpad/ui/SpendingCard.tsx`**

| Before | After |
|---|---|
| `Where the treasury's money went` | `Where the project's money went` |
| `when it ran could not be read` | `when it happened could not be read` |
| `its transaction was not found` | `we could not find its record` |
| `reading when it ran…` | `reading when it happened…` |
| `This DAO has more work budgets or submissions than this page reads, so the reviewed-work figures may be low.` | `This project has more work budgets or submissions than this page reads, so the reviewed-work figures may be low.` |

**`features/launchpad/ui/TreasuryFlowsPanel.tsx`**

| Before | After |
|---|---|
| (nothing) | `New wording added: windows / in total / per day / per week / per month / windows / in total / today / this week / this month` |
| `What happened to the money at graduation` | `What happened to the money when the sale ended` |
| `The raise swept to the executor and split onchain:` | `The money raised went to the payout step and was split on the network:` |
| `<strong>{amounts.money(split.reserveShare)}</strong> held in escrow for the market's price floor ({Number(state.reserveBps) / 100}% of the` | `<strong>{amounts.money(split.reserveShare)}</strong> set aside for the market's price floor ({Number(state.reserveBps) / 100}% of the` |
| `<dt>Reserve escrow (from the record)</dt>` | `<dt>Set aside for the price floor (from the record)</dt>` |
| `<dt>Treasury share (from the record)</dt>` | `<dt>Project's share (from the record)</dt>` |
| `<dt>Executed</dt>` | `<dt>Split done</dt>` |
| `<dt>Executor (source)</dt>` | `<dt>Payout step (contract)</dt>` |
| `<dt>Treasury (source)</dt>` | `<dt>Project's money (contract)</dt>` |
| `TM pool master:` | `Market pool contract:` |
| `No sweep / lock / summon / ragequit receipts are recorded for this launch yet. The deploy publishes them at graduation.` | `No money movements are recorded for this project yet. They are recorded when the sale ends.` |
| `sweep: raised ${payloadAmount(row.payload, "currencyRaised", amounts.money)}, treasury share ${payloadAmount(row.payload, "treasuryShare", amounts.money)}, unsold ${payloadAmount(row.payload, "unsoldTokens", amounts.tokens)}` | `Money raised ${payloadAmount(row.payload, "currencyRaised", amounts.money)}: project's share ${payloadAmount(row.payload, "treasuryShare", amounts.money)}, unsold tokens ${payloadAmount(row.payload, "unsoldTokens", amounts.tokens)}` |
| `lock: reserve escrow ${payloadAmount(row.payload, "reserveEscrow", amounts.money)} (price-floor backing; the treasury can withdraw it after the reserve lock if no pool is recorded)` | `Set aside: ${payloadAmount(row.payload, "reserveEscrow", amounts.money)} to back the price floor (the project can take it back after the hold if no pool is recorded)` |
| `"summon: the DAO was summoned for this launch" : "ragequit: an owner burned shares and claimed treasury"}` | `"The project was set up for this sale" : "Exit: an owner gave up shares and took their part of the project's money"}` |
| `treasury: "Treasury holds", pool: "TM pool holds (price-floor backing)", escrow: "Executor still holds (unreleased reserve)"` | `treasury: "The project holds", pool: "The market pool holds (price-floor backing)", escrow: "The payout step still holds (money not yet released)"` |
| `Live contract reads (balances of the linked addresses).` | `Read live from the network (balances of the linked addresses).` |
| `Could not read the allowance:` | `Could not read the spending limit:` |
| `onchain: spent {amounts.money(allowanceQuery.data.spent)} of {amounts.money(allowanceQuery.data.allowance)} this {window} (epoch {allowanceQuery.data.epoch.toString()}), remaining {amounts.money(allowanceQuery.data.remaining)}` | `On the network: spent {amounts.money(allowanceQuery.data.spent)} of {amounts.money(allowanceQuery.data.allowance)} {THIS_WINDOW[window]} (period {allowanceQuery.data.epoch.toString()}), {amounts.money(allowanceQuery.data.remaining)} left` |
| `· spender` | `· allowed to spend:` |
| `Reading the allowance…` | `Reading the spending limit…` |
| `No onchain allowance is bound to this budget (record-only ceiling).` | `The network does not enforce a spending limit for this budget; its limit is a written record only.` |
| `spend {amounts.money(spend.amount)} by` | `spent {amounts.money(spend.amount)} by` |
| `recorded spend receipts total {amounts.money(recorded)} (advisory mirror of the onchain ledger)` | `recorded payments total {amounts.money(recorded)} (a copy for information; the network's own ledger is the source)` |
| `No spend receipts recorded against this budget yet.` | `No payments recorded against this budget yet.` |
| `What is happening: the raise split at graduation, the reserve seeds the price floor, the treasury funds the project. Does it need you: only when you hold shares and want out (see Exit below). What to do about it: every movement below links the transaction or contract it came from.` | `When the sale ended, the money raised was split: part is set aside to back the token's price floor, and the rest is the project's money. You only need to act if you hold shares and want out (see Exit below). Each item below links to its record on the network.` |
| `This launch is not on the GraduationExecutor rails (its funds recipient is not a GraduationExecutor), so the split cannot be read:` | `This sale does not use the standard payout step, so how the money was split cannot be shown:` |
| `Reading the graduation split…` | `Reading how the money was split…` |
| `What has been spent (budgets & spend ledger)` | `What has been spent (budgets and payments)` |
| `Could not read the budgets and spend ledger from the server:` | `Could not read the budgets and payments from the server:` |
| `Reading budgets and spend receipts…` | `Reading budgets and payments…` |
| `Source: the budgets and spend receipts published in this community, checked against the onchain spending allowance. Current period:` | `Source: the budgets and payments published in this community, checked against the spending limit on the network. Current period:` |
| `No budgets are published in this community yet, so the spend ledger shows onchain data only. The budget picture appears once budgets are` | `No budgets are published in this community yet, so only what the network records is shown. Budgets appear here once they are` |
| `treasury. The escrow is a promise the treasury keeps, not a guarantee: it is released to the recorded pool, and if no pool is recorded the treasury can withdraw it once the executor's reserve lock (30 days by default) has passed. Unsold launch tokens ( {amounts.tokens(state.record.unsoldTokens)}) went to the treasury; sold` | `project's money. The set-aside money is a promise the project keeps, not a guarantee: it goes to the recorded market pool, and if no pool is recorded the project can take it back once the hold on it (30 days by default) has passed. Unsold tokens ( {amounts.tokens(state.record.unsoldTokens)}) went to the project; sold` |
| `Source: the receipts this launch published for its deploy and exits; each links to its transaction on the chain.` | `Source: the records this project saved when the sale ended and when people left; each links to its record on the network.` |
| `budget {budget.id}: ceiling {budget.allocation ? amounts.money(budget.allocation) : "—"} / {window}` | `budget {budget.id}: limit {budget.allocation ? amounts.money(budget.allocation) : "—"} {PER_WINDOW[window]}` |
| `subject {truncatePubkey(budget.subject)}` | `for {truncatePubkey(budget.subject)}` |

**`features/launchpad/ui/TreasuryTab.tsx`**

| Before | After |
|---|---|
| `From the published terms: commitments, not a measured balance.` | `The money the project holds together. These figures come from the published terms: commitments, not a measured balance.` |
| `Raise if it clears at the floor` | `Raise if all tokens sell at the floor price` |
| `Liquidity is seeded from the clearing price at graduation; the remainder is the treasury's. Allowances, streams and the wind-down path are agreed by proposal, not configured here.` | `When the sale ends, part of the raise is set aside to start a market for the token, at the price the sale settled on. The rest is the project's money. Spending limits, payment streams and how to wind the project down are agreed by proposal, not set here.` |
| `Link the token and treasury addresses to read a balance.` | `This project has no money account linked yet. Ask the founder to add it.` |
| `Read the treasury's balance of the launch token over RPC.` | `Check how much of the project's token the project holds.` |
| `The chain could not be read, so the balance is unknown.` | `The network did not answer, so the balance is unknown.` |
| `Read balance` | `Check balance` |
| `No streams yet. SubDAOs receive revocable streams against milestones. Continuation, top-up, or cancel follows a budget vote.` | `No payment streams yet. Sub-projects are paid in streams tied to milestones, and a stream can be cancelled. Continuing, topping up or cancelling a stream follows a budget vote.` |
| `The credible threat of taking money back is what disciplines a treasury. Anyone can suggest returning the money. A suggestion is a public note for the holders to discuss: it does not move any money and it is not a vote. A decision that does is put to the holders on the Decisions tab.` | `Anyone can suggest returning the project's money to holders. A suggestion is a public note for the holders to discuss: it does not move any money and it is not a vote. A decision that does is put to the holders on the Decisions tab.` |
| `e.g. Return the remaining treasury pro-rata` | `e.g. Return the remaining money to holders, in proportion to their Shares` |
| `returnTitle.trim() \|\| "Return the remaining treasury pro-rata"` | `returnTitle.trim() \|\| "Return the remaining money to holders, in proportion to their Shares"` |

**`features/launchpad/ui/TxLink.tsx`**

| Before | After |
|---|---|
| `This network has no public page for transactions, so only its id is shown.` | `Only the record's ID is shown. Keep it if you need to look the record up later.` |

### Creating a project: sale plans, share rules, unlock plans and the IP record

**`features/launchpad/lib/contract-names.ts`**

| Before | After |
|---|---|
| `mandate.isMilestonePanel ? "The milestone panel" : "A work budget"` | `mandate.isMilestonePanel ? "Milestone reviewers" : "A work budget"` |

**`features/launchpad/lib/ip-record.ts`**

| Before | After |
|---|---|
| `The ${name} needs a title, an https link and a fingerprint of 64 characters, or leave all three empty.` | `The ${name} needs a title, a link starting with https and a fingerprint of 64 characters, or leave all three empty.` |

**`features/launchpad/lib/launch-panel.ts`**

| Before | After |
|---|---|
| `That address does not look like a token on this network.` | `We could not read a token at that address on this network. Check it and try again.` |

**`features/launchpad/lib/launch-params.ts`**

| Before | After |
|---|---|
| `error("supply", "The sale needs a supply greater than zero.")` | `error("supply", "The sale needs more than zero tokens to sell.")` |
| `Supply is above the auction's ceiling (2^100 units), which the clearing price cannot support.` | `That is more tokens than a sale can handle Lower the total supply.` |
| `Tick spacing must be at least ${MIN_TICK_SPACING}: spacing 1 lets rounding move the price off an initialized tick.` | `The price step must be at least ${MIN_TICK_SPACING}: with a step of 1, rounding can push a price off its level.` |
| `The floor price is too low for the auction to price anything. Raise it.` | `The floor price is too low for the sale to work. Raise it.` |
| `Tick spacing is above the maximum this supply supports; the auction cannot be deployed.` | `The price step is too large for this many tokens, so the sale cannot be created. Lower it.` |
| `Floor price plus tick spacing is above the maximum this supply supports; the auction cannot be deployed.` | `The floor price plus the price step is too high for this many tokens, so the sale cannot be created. Lower the price.` |
| `Floor price must be a multiple of the tick spacing (${input.tickSpacing}); the floor is the first tick.` | `The floor price must be a multiple of the price step (${input.tickSpacing}), because the floor is the first price level.` |
| `Monthly budget: above a sixth of the graduation threshold. At the cap the auction refills the treasury every six months.` | `The monthly budget is above a sixth of the raise target, so the money raised would last less than six months.` |
| `error("endBlock", "The auction must end after it starts.")` | `error("endBlock", "The sale must end after it starts.")` |
| `error("claimBlock", "Claims cannot open before the auction ends.")` | `error("claimBlock", "People cannot collect before the sale ends.")` |
| `error("steps", "An auction needs at least one issuance step.")` | `error("steps", "The sale needs at least one release step.")` |
| `` error(`steps[${index}]`, "A step cannot last zero blocks.") `` | `` error( `steps[${index}]`, `Release step ${index + 1} must last at least one block (a block is a short slice of network time).`, ) `` |
| `` error(`steps[${index}]`, "A step must sell something every block.") `` | `` error( `steps[${index}]`, `Release step ${index + 1} must sell something in every block.`, ) `` |
| `Issuance must add up to 100%: the steps sum to ${sumMps} of ${MPS} milli-bips.` | `The release steps must add up to the whole sale (100%). Right now they add up to ${Number((sumMps * 10_000n) / MPS) / 100}%.` |
| `The steps span ${sumDelta} blocks, ending at ${input.startBlock + sumDelta} rather than ${input.endBlock}.` | `The release steps last ${sumDelta} blocks and end at block ${input.startBlock + sumDelta}, not block ${input.endBlock}.` |
| `The final step sells under 1% of the supply, so almost all of it clears before the auction ends.` | `The last release step sells under 1% of the tokens, so almost all of them are sold before the sale ends.` |
| `With no graduation threshold the auction graduates however little it raises.` | `With no raise target, the sale goes ahead however little it raises.` |
| `The threshold is above the most this supply could ever raise, so the auction can never graduate.` | `The raise target is higher than this many tokens could ever raise, so the sale can never reach it.` |
| `The threshold is above what selling the whole supply at the floor price would raise, so it needs bids well above the floor.` | `The raise target is above what selling every token at the floor price would raise, so it needs bids well above the floor.` |

**`features/launchpad/lib/listing-draft.ts`**

| Before | After |
|---|---|
| `This build knows no secondary market on this network.` | `This version of the app has no weekly market on this network.` |
| `"The market could not be read. Reload to try again." : "Reading the market…"` | `"We could not load the market. Reload the page to try again." : "Loading the market…"` |
| `This project has no secondary market to publish a listing in.` | `This project has no weekly market to list Shares in.` |
| `The market could not be read. Reload to try again.` | `We could not load the market. Reload the page to try again.` |
| `The market's price token could not be read just now.` | `We could not load the market's price token just now. Try again in a moment.` |

**`features/launchpad/lib/quick-sale.ts`**

| Before | After |
|---|---|
| `value: input.formDao ? "It becomes a DAO" : "No DAO"` | `value: input.formDao ? "Holders vote on how the money is spent" : "Holders do not vote on the money"` |

**`features/launchpad/lib/sale-plans.ts`**

| Before | After |
|---|---|
| `One price, one flat release across the window. The whole tranche sells at the price you set or every bid refunds.` | `One price, with tokens released evenly across the sale. The whole batch sells at the price you set, or every bid is refunded.` |
| `Liquidity bootstrap` | `Front-loaded sale` |
| `Most of the tranche comes online in the first third of the window. It all sells, or every bid refunds.` | `Most of the batch is released in the first third of the sale. It all sells, or every bid is refunded.` |
| `Graduating auction` | `Standard auction` |
| `A release that starts fast and tapers. It all sells at the floor or higher, or every bid refunds.` | `Tokens are released fast at first, then more slowly. It all sells at the floor price or higher, or every bid is refunded.` |

**`features/launchpad/lib/sale-steps.ts`**

| Before | After |
|---|---|
| `Deploy the token and the sale` | `Set up the token and the sale` |

**`features/launchpad/lib/unlock-plans.ts`**

| Before | After |
|---|---|
| `Milestone payouts can be enforced onchain: each milestone becomes a claim whose payout is held in escrow and released only when enough verifiers approve it. It is optional per launch; until a milestone is escrowed and claimed, releasing it is a treasury decision recorded on the launch.` | `The network can enforce milestone payouts: each milestone becomes a submission, its payout is set aside, and it is released only when enough reviewers approve it. This is optional for each launch. Until a milestone is set aside and submitted, releasing it is a decision about the project's money, recorded on the launch.` |
| `Short vesting is 3 or 6 months.` | `A short unlock schedule is 3 or 6 months.` |
| `A milestone plan needs ${MIN_MILESTONES}–${MAX_MILESTONES} rows.` | `A milestone plan needs ${MIN_MILESTONES}–${MAX_MILESTONES} milestones.` |
| `Milestone claim ids must be unique.` | `Every milestone needs its own ID.` |
| `Milestone tranches must add up to 100% of the milestone allocation (they add up to ${total}%).` | `The milestone parts must add up to 100% of what the milestones unlock (they add up to ${total}%).` |
| `Every milestone releases something.` | `Every milestone must unlock more than 0%.` |

**`features/launchpad/lib/vesting-params.ts`**

| Before | After |
|---|---|
| `Cliff cannot be negative.` | `The wait before the first unlock cannot be negative.` |
| `Tranches must sum to 100% (got ${total}%).` | `The parts must add up to 100% (they add up to ${total}%).` |
| `Price multiples must be strictly ascending.` | `Each price multiple must be higher than the one before.` |
| `A tranche at 1x would unlock at the raise price. Performance means above it.` | `A part at 1x would unlock at the raise price. Price-based unlocks should start above it.` |
| `The TWAP window must be positive blocks.` | `The price-averaging window must be more than 0 blocks.` |

**`features/launchpad/lib/wizard.ts`**

| Before | After |
|---|---|
| `Whether the project becomes a DAO, and what it may spend.` | `Whether holders vote on the project's money, and what it may spend.` |
| `The token needs a symbol.` | `Add a short symbol for the token, like NEB.` |
| `Launch id must be lowercase letters, digits, dashes or underscores.` | `The page address can use only lowercase letters, numbers, dashes and underscores.` |
| `A project with its own DAO locks its team's Shares behind milestones, or not at all. Choose milestones or no lock.` | `Because holders run this project, its team's Shares can be locked only behind milestones, or not at all. Choose milestones or no lock.` |
| `Monthly budget must be a whole number of base units.` | `The monthly budget must be a whole number in the currency's smallest unit.` |
| `Chain id must be a number, e.g. 11155111.` | `The network ID must be a number, for example 11155111.` |
| `Auction and treasury must be 0x addresses when set.` | `The ${addressNames[field]} address must be a full address starting with 0x, or left empty.` |

**`features/launchpad/ui/CreateLaunchDialog.tsx`**

| Before | After |
|---|---|
| `Raw blocks: set all three, with claims opening at or after the end.` | `Set all three block numbers in Advanced, with collecting opening at or after the end, or clear them.` |
| `Reading this chain's block time…` | `Working out the sale dates from the network…` |
| `"This chain could not be read, so the launch will publish with no block window. Set raw blocks in Advanced if you know them." : "Pick an end date in the future to see the window."` | `"We could not reach the network, so the sale will be published without dates. If you know them, enter the sale window in Advanced." : "Pick an end date in the future to see the sale dates."` |
| `No graduation line yet. Pick a price so there is one.` | `No raise target yet. Pick a price to set one.` |
| `A custom price ladder from Advanced also applies on top of this plan.` | `The price-based unlocks you set in Advanced also apply on top of this plan.` |
| `${capLine} Publishing still works, and the launch shows the warning. Summoning the DAO with a budget over the cap won't go through.` | `${capLine} You can still publish, and the launch page shows this warning. Creating the project with a budget over this limit will not go through.` |
| `${equity?.length ?? 0} ${(equity?.length ?? 0) === 1 ? "person" : "people"} from the project's team list. The DAO starts with exactly these Shares.` | `${equity?.length ?? 0} ${(equity?.length ?? 0) === 1 ? "person" : "people"} from the project's team list. The project's Shares start out split exactly like this.` |
| `exact values, raw blocks, cliffs and hooks` | `exact values, block numbers and price-based unlocks` |
| `` })} a token. Graduates at ${formatMoney(form.requiredRaised, saleCurrency)} raised; below that, every bid refunds.` `` | `` })} a token. The sale goes ahead if it raises ${formatMoney(form.requiredRaised, saleCurrency)}; below that, every bid is refunded.` `` |

**`features/launchpad/ui/DaoLaunchPanel.tsx`**

| Before | After |
|---|---|
| `One transaction. It mints the Shares, locks the team's allocation, and sends the raise to the DAO.` | `One step on the network. It creates the Shares, locks the team's allocation, and sends the raise to the DAO.` |
| `One transaction creates the project's DAO and opens the sale of its Shares. The raise goes straight to the DAO's treasury, never to your wallet, and backers can leave with their part of it. Your team` | `A DAO is a project run by its holders' votes, with its money held in the open. One step creates the project's DAO and opens the sale of its Shares. The raise goes straight to the DAO's money, never to your own account, and backers can leave with their part of it. Your team` |
| `milestone cannot be sold or taken out until that milestone is reached.` | `milestone cannot be sold or withdrawn until that milestone is reached.` |
| `left in the treasury before the first milestone` | `left of the project's money before the first milestone` |

**`features/launchpad/ui/HowItWorks.tsx`**

| Before | After |
|---|---|
| `agreed before you started, that exact quantity of Shares is already reserved, and it settles on those terms once the wait is over. Work nobody agreed a reward for goes to the project's holders, who vote on whether to award Shares. Approval alone gives you none. Shares are your votes in what the project does next.` | `agreed before you started, that exact number of Shares is already set aside, and you receive it once the wait is over. Work nobody agreed a reward for goes to the project's holders, who vote on whether to award Shares. Approval alone gives you none. Shares are your votes in what the project does next.` |

**`features/launchpad/ui/IpDocumentField.tsx`**

| Before | After |
|---|---|
| `Link (https)` | `Link to the document` |
| `Choose the file to fingerprint it` | `Choose a file to fill in its fingerprint` |
| (nothing) | `<TechnicalDetails detail="The fingerprint is a SHA-256 hash of the file, written as 64 letters and numbers (0 to 9, a to f). The link must start with https://." />` |
| `Fingerprint (SHA-256)` | `Fingerprint` |

**`features/launchpad/ui/IpRecordCard.tsx`**

| Before | After |
|---|---|
| (nothing) | `New wording added: A fingerprint is a short code made from a file. If the file changes, the code changes, so anyone can tell.` |
| (nothing) | `<p> IP means the rights to the project's work, such as its code, name and designs. </p>` |

**`features/launchpad/ui/LaunchCard.tsx`**

| Before | After |
|---|---|
| `Run by agent ${record.agent.slice(0, 8)}…` | `Run by an AI helper (${record.agent.slice(0, 8)}…)` |
| `Raise needed to graduate` | `Amount the raise must reach for the sale to complete` |
| `Agent-run` | `AI-run` |

**`features/launchpad/ui/LaunchContractsCard.tsx`**

| Before | After |
|---|---|
| `["Treasury", record.treasury]` | `["Project's money", record.treasury]` |

**`features/launchpad/ui/LaunchHero.tsx`**

| Before | After |
|---|---|
| `Run by agent ${record.agent.slice(0, 8)}…` | `Run by an AI helper (${record.agent.slice(0, 8)}…)` |
| `Agent-run` | `AI-run` |

**`features/launchpad/ui/LaunchPanelFields.tsx`**

| Before | After |
|---|---|
| `One wallet address per line.` | `One account address per line, starting with 0x.` |
| `Optional. Each reviewer posts this before judging, and loses it if the DAO finds they approved carelessly. Leave empty for none.` | `Optional. A bond is a deposit each reviewer puts down before judging. They lose it if the project finds they approved carelessly. Leave empty for none.` |
| `Bond each reviewer must post` | `Bond each reviewer must put down` |
| `A bond only deters if it keeps its value and nobody involved can freeze or inflate it. Check the token before you launch.` | `A bond only works if it keeps its value and nobody involved can freeze it or create more of it. Check the token before you launch.` |
| `thing the DAO can then do with them is give them up and burn them. Ask your reviewers first, and name more people than the number who must agree.` | `thing the project can then do with them is give them up and destroy them. Ask your reviewers first, and name more people than the number who must agree.` |

**`features/launchpad/ui/LaunchReviewFields.tsx`**

| Before | After |
|---|---|
| `The team publishes evidence, holders get time to object, and with no objection anyone can finalize the unlock. There are no reviewers to find or keep reachable.` | `The team publishes evidence, holders get time to object, and with no objection anyone can complete the unlock. There are no reviewers to find or keep reachable.` |
| `For ${span(waits.clawback)} after an unlock one more objection is possible, and if holders uphold it your remaining locked Shares are burned.` | `For ${span(waits.clawback)} after an unlock one more objection is possible, and if holders agree with it your remaining locked Shares are destroyed.` |
| `one before has had its time for late objections. Until then, an upheld late objection can still burn the Shares behind the later milestones. Once the last one has unlocked, only your bond stands behind it.` | `one before has had its time for late objections. Until then, a late objection that holders agree with can still destroy the Shares behind the later milestones. Once the last one has unlocked, only your bond (the deposit you put down) stands behind it.` |
| `and you can reclaim the final bond on day` | `and you can get the final bond back on day` |
| `finalizing each unlock. Actual delivery and objections can make it` | `completing each unlock. Actual delivery and objections can make it` |
| `` `You post this with each milestone and get it back ${bondBack}, unless holders turn it down. Leave empty for ${formatAtomic(defaultBond, currencyDecimals, { maxFractionDigits: 2 })} ${currencySymbol}, 1% of your raise target.` : `You post this with each milestone and get it back ${bondBack}, unless holders turn it down. Leave empty for 1% of your raise target.` `` | `` `You put this down with each milestone and get it back ${bondBack}, unless holders turn it down. Leave empty for ${formatAtomic(defaultBond, currencyDecimals, { maxFractionDigits: 2 })} ${currencySymbol}, 1% of your raise target.` : `You put this down with each milestone and get it back ${bondBack}, unless holders turn it down. Leave empty for 1% of your raise target.` `` |
| `Bond you post with each milestone (${currencySymbol})` | `Bond you put down with each milestone (${currencySymbol})` |

**`features/launchpad/ui/LaunchesPage.tsx`**

| Before | After |
|---|---|
| `Walk through a full raise, start to finish. No blockchain and no real money.` | `Walk through a full raise, start to finish. It is only practice: no real money is used.` |
| `No launches have graduated yet.` | `No sales have completed yet.` |

**`features/launchpad/ui/create-wizard/AdvancedFields.tsx`**

| Before | After |
|---|---|
| `label="Launch id" hint="Lowercase slug. Permanent: it addresses the launch on the server. Left empty, it is derived from the name."` | `label="Page address" hint="The web address of the launch page: lowercase letters, numbers, dashes and underscores. It cannot be changed later. Leave empty to use the name."` |
| `What is already built, who is on the team, what you will build next, and what would show the thesis is wrong.` | `What is already built, who is on the team, what you will build next, and what would show the idea is wrong.` |
| `One link per line: repos, docs, social accounts, domains.` | `One link per line: code, documents, social accounts or web addresses you own.` |
| `What you commit to telling investors, e.g. "monthly with KPIs".` | `What you commit to telling investors, for example "monthly, with numbers".` |
| `monthly with KPIs` | `monthly, with numbers` |
| `DAO and the sale together: the raise lands in the DAO, the team's` | `DAO and the sale together: the raise goes to the DAO, the team's` |
| `with their share of the treasury. Name, symbol and total supply are on the first step.` | `with their share of the project's money. Name, symbol and total supply are on the first step.` |
| `<Field id="launch-chain" label="Chain id" hint="11155111 = Sepolia.">` | `<Field id="launch-chain" label="Network ID" hint="11155111 is the Sepolia test network." >` |
| `Curated picks who can bid. Community is open to everyone.` | `Curated: you pick who can bid. Community: anyone can bid.` |
| `Performance vesting (optional)` | `Price-based unlocks (optional)` |
| `<p>Performance vesting</p>` | `<p>Price-based unlocks</p>` |
| `Cliff (blocks)` | `Wait before the first unlock (blocks)` |
| `Tranches (multiple:percent, one per line)` | `Parts (multiple:percent, one per line)` |
| `Smallest currency units. The wizard's price writes this; type here to override it.` | `In the currency's smallest units. The price you set in the steps fills this in; type here to override it.` |
| `label="Graduation threshold" hint="Minimum proceeds, in currency base units. Miss it and every bid refunds in full."` | `label="Raise target (smallest units)" hint="The least the sale must raise, in the currency's smallest units. Miss it and every bid is refunded in full."` |
| `label="Sale window (raw blocks)" hint="The wizard derives these from the dates you picked. Override all three, or leave them empty."` | `label="Sale dates (block numbers)" hint="The steps fill these in from the dates you picked. Override all three, or leave them empty."` |
| `aria-label="Claims open at block"` | `aria-label="Collecting opens at block"` |
| `Set all three blocks, with claims at or after the end, or clear them and let the wizard convert your dates.` | `Set all three block numbers, with collecting opening at or after the end, or clear them and we will work them out from your dates.` |
| `Sale & treasury details` | `Sale and money details` |
| `Operating budget in currency base units; above a sixth of the threshold this warns.` | `The monthly operating budget, in the currency's smallest units. Above a sixth of the raise target, you get a warning.` |
| `label="Tick spacing" hint="Price granularity."` | `label="Price step" hint="The gap between allowed bid prices, in the same units as the floor price."` |
| `label="Auction contract" hint="Optional now. Link it when the sale deploys."` | `label="Sale contract" hint="Optional for now. Add it once the sale is created."` |
| `label="Treasury" hint="Receives the minted supply. Optional now."` | `label="Treasury (the project's money)" hint="Receives the newly created supply. Optional for now."` |
| `Tranches unlock as the token price reaches multiples of the raise price (2x up to 32x by default). This is recorded on the launch for now; onchain enforcement comes with verifier milestones.` | `Parts unlock as the token price reaches multiples of the raise price (2x up to 32x by default). This is recorded on the launch for now; the network will enforce it later, with milestone reviewers.` |
| `claims` | `collect` |

**`features/launchpad/ui/create-wizard/CurrencyChoice.tsx`**

| Before | After |
|---|---|
| `Steady dollar prices` | `A digital dollar, so prices stay steady` |

**`features/launchpad/ui/create-wizard/SupplySplit.tsx`**

| Before | After |
|---|---|
| `` `This seeds the pool with under ${minLiquidity}% of supply. It covers less than 20% of the floor raise, so day-one liquidity will be thin.` : `A pool at ${allocation.liquidity}% of supply covers ${Math.round( `` | `` `You are setting aside under ${minLiquidity}% of the tokens so people can trade right after the sale. That is less than 20% of the raise at the floor price, so trading will be thin: holders may find it hard to sell at a fair price.` : `You are setting aside ${allocation.liquidity}% of the tokens so people can trade right after the sale. That matches ${Math.round( `` |
| `` )}% of the floor raise at the floor price.`} `` | `` )}% of the raise at the floor price.`} `` |

**`features/launchpad/ui/create-wizard/WizardSteps.tsx`**

| Before | After |
|---|---|
| `A short ticker, like NEB.` | `A short code for the token, like NEB.` |
| `Your team's Shares are yours to vote with from the start. A milestone decides when a part of them can be sold or taken out of the DAO.` | `Your team's Shares are yours to vote with from the start. A milestone decides when part of them can be sold, or used to leave with a share of the project's money.` |
| `Released over time (not available with its own DAO)` | `Released over time (not available for this project)` |
| `Nothing is locked: your team Shares can be sold or taken out of the DAO straight away.` | `Nothing is locked: your team Shares can be sold, or used to leave with a share of the project's money, straight away.` |
| `These milestones are enforced when you launch: the part tied to each one cannot be sold or taken out of the DAO until the milestone is reached. By default you publish evidence and holders get a week to object; you can name reviewers instead when you launch. The words of a milestone are what it is judged by.` | `These milestones are enforced when you launch: the part tied to each one cannot be sold, or used to leave with a share of the project's money, until the milestone is reached. By default you publish evidence and holders get a week to object; you can name reviewers instead when you launch. A milestone is judged by exactly the words you write.` |
| `Adds up to 100% of your milestone allocation.` | `Adds up to 100% of what the milestones unlock.` |
| `The DAO's reviewers decide whether each milestone was met.` | `The project's reviewers decide whether each milestone was met.` |
| `Shown on the project page. Starting with none is a fine choice; you can decide later.` | `Whether a company or similar body stands behind the project. Shown on the project page. Starting with none is a fine choice; you can decide later.` |
| `Legal wrapper` | `Legal structure` |
| `Everyone who holds Shares votes on how the money is spent, from the first day. The DAO is created in the same step that opens the sale; there is nothing to set up afterwards.` | `A DAO is a project run by its holders' votes, with its money held in the open. Everyone who holds Shares votes on how the money is spent, from the first day. It is created in the same step that opens the sale; there is nothing to set up afterwards.` |

**`features/launchpad/ui/create-wizard/ParamIssueList.tsx`**

| Before | After |
|---|---|
| `{issue.field}: {issue.message}` | `{issue.message}` |

### Weekly sales, bids and trading

**`features/launchpad/lib/bid-tx.ts`**

| Before | After |
|---|---|
| `This max price is above the ceiling the token supply allows, so the bid won't go through. Lower the max price.` | `Your highest price is above the ceiling the token supply allows, so the bid won't go through. Lower your highest price.` |
| `Max price must sit on the auction's tick grid (the price step this auction uses), or the bid won't go through.` | `Your highest price must be a multiple of this sale's price step, or the bid won't go through.` |
| `Max price must be above the current clearing price.` | `Your highest price must be above the current clearing price.` |

**`features/launchpad/lib/my-bids.ts`**

| Before | After |
|---|---|
| `Checkpoint data is inconsistent with this bid. Refresh, and report this if it persists.` | `The sale data on this page does not match your bid. Refresh, and tell the team if it keeps happening.` |
| `return { kind: "unavailable", reason: "This bid is already exited." }` | `return { kind: "unavailable", reason: "The unspent money from this bid was already taken back.", }` |
| `Exit opens when the auction ends. Early exit needs a graduated auction.` | `You can take back unspent money when the sale ends. Before then, only if the sale has already raised its minimum.` |
| `Exit opens at the auction end, or earlier if this bid is outbid on a graduated auction.` | `You can take back unspent money when the sale ends, or earlier if the price rises above your highest price and the sale has already raised its minimum.` |
| `Claim unlocks after this bid is exited.` | `You can collect tokens after you take back the unspent money.` |
| `Nothing left to claim. This bid is settled.` | `Nothing left to collect. This bid is finished.` |
| `Tokens can only be claimed on a graduated auction.` | `Tokens are only handed out if the sale raised its minimum.` |
| `Claim unlocks at block ${auction.claimBlock}.` | `Collecting tokens is not open yet. It opens a little after the sale ends. Check back later.` |
| `checkpoint: "Write checkpoint", exit: "Exit bid", claim: "Claim tokens"` | `checkpoint: "Saving the sale's price record", exit: "Taking back unspent money", claim: "Collecting tokens"` |

**`features/launchpad/lib/rounds-copy.ts`**

| Before | After |
|---|---|
| `Another contract was voted in to move Shares, so weekly rounds aren't on. Turn it off first, then start rounds.` | `Another contract was voted in to move Shares, so weekly rounds aren't on. Turn that one off first, then start rounds.` |
| `The DAO sells at least 2% above what leaving pays.` | `The project sells at least 2% above what leaving pays.` |
| `If the round settles there, you keep ${usdc(keepsEach)} a Share after the treasury's cut. A higher price pays you more; below it, nothing sells.` | `If the round settles there, you keep ${usdc(keepsEach)} a Share after the project's cut. A higher price pays you more; below it, nothing sells.` |

**`features/launchpad/lib/trading-copy.ts`**

| Before | After |
|---|---|
| `The market couldn't be read just now, so this page can't say whether this DAO has one. Reload to try again.` | `The market couldn't be read just now, so this page can't say whether this project has one. Reload to try again.` |
| `The DAO has turned trading off, so no new offers or bids are taken. This round closes ${date(round.closesAt)} and still settles.` | `The project has turned trading off, so no new offers or bids are taken. This round closes ${date(round.closesAt)} and still settles.` |
| `This DAO has no secondary market. A DAO made before the market existed, or made without one, has none.` | `This project has no market for its Shares. A project made before the market existed, or made without one, has none.` |
| `Trading is off: the DAO has no open listing. Opening one is the DAO's decision.` | `Trading is off: the project has no open listing. Opening one is the project's decision.` |
| `The latest round went void, so everyone takes back what they put in.` | `The latest round was not settled in time, so everyone takes back what they put in.` |
| `Your order is waiting for the round to be settled. Anyone can settle it and it costs only a network fee. If nobody does by ${date(round.settleDeadline)}, the round is void and you take back what you put in.` | `Your order is waiting for the round to be settled. Anyone can settle it and it costs only a network fee. If nobody does by ${date(round.settleDeadline)}, the round is not settled and you take back what you put in.` |
| `` `${offer} The round went void, so they are back with you.` : `${offer} The round went void, so they are yours to take back.` `` | `` `${offer} The round was not settled in time, so they are back with you.` : `${offer} The round was not settled in time, so they are yours to take back.` `` |
| `${offer} The round went void, so your money comes back to you.` | `${offer} The round was not settled in time, so your money comes back to you.` |

**`features/launchpad/ui/HoldersCard.tsx`**

| Before | After |
|---|---|
| `` `${countOf(read.found, "wallet")} ${read.found === 1 ? "holds" : "hold"} Shares.` : `The largest ${read.holders.length} of ${read.found} wallets that hold Shares.`} `` | `` `${countOf(read.found, "account")} ${read.found === 1 ? "holds" : "hold"} Shares.` : `The largest ${read.holders.length} of ${read.found} accounts that hold Shares.`} `` |
| `"Time held is the average moment the Shares were acquired: buying more brings it down, and Shares passed to another wallet do not take their time with them." : "This DAO was made before holding times were kept, so only what each wallet holds is shown."}` | `"Time held counts from the average date the Shares were acquired: buying more shortens it, and Shares passed to another account do not carry their time over." : "This project was made before holding times were kept, so only what each account holds is shown."}` |
| `The DAO itself` | `The project itself` |

**`features/launchpad/ui/LockedSharesCard.tsx`**

| Before | After |
|---|---|
| `These Shares are yours and count when the DAO votes. The part tied to a milestone cannot be sold or taken out of the DAO until that milestone is reached.` | `These Shares are yours and count when the project votes. The part tied to a milestone cannot be sold, or given up when you leave, until that milestone is reached.` |

**`features/launchpad/ui/MyBidsPanel.tsx`**

| Before | After |
|---|---|
| `No connected account found. Connect a browser wallet, or set up passkey sign-in from your profile menu, to see your bids here.` | `No connected account found. Connect a wallet app, or set up passkey sign-in from your profile menu, to see your bids here.` |
| `<p> Could not read bids: {snap.error} </p>` | `<div> <p> We couldn't read your bids just now. Press Refresh to try again. </p> <TechnicalDetails detail={snap.error} /> </div>` |
| `No bids from this account on this auction.` | `This account has no bids on this sale.` |
| `Claim all ({claimable.length})` | `Collect all ({claimable.length})` |
| `Done. Receipts:` | `Done. Confirmation IDs:` |
| `Retry remaining` | `Retry the rest` |

**`features/launchpad/ui/RecordBidDialog.tsx`**

Also: 1 server message(s) now end with 'Try again.'.

| Before | After |
|---|---|
| `The sender returned an invalid hash.` | `We did not get a valid confirmation ID back. Check whether the bid went through before you send it again.` |
| `Transaction hash must be 0x + 64 hex characters.` | `That confirmation ID is not valid. It is 0x followed by 64 letters and numbers.` |
| `Send the bid first, or paste the hash of a bid you made elsewhere.` | `Send the bid first, or paste the confirmation ID of a bid you made elsewhere.` |
| `Your bid goes from your wallet straight to the auction, and is recorded on this launch's page so the founder and others can see it.` | `Your bid goes from your account straight to the sale, and is recorded on this launch's page so the founder and others can see it.` |
| `Before you bid: your money goes to the project's treasury, which holders vote on, and the team votes too. The milestones lock the` | `Before you bid: your money becomes part of the project's money, which holders vote on, and the team votes too. The milestones lock the` |
| `This launch has no auction contract linked yet, so it cannot accept bids. You can compose the terms below but nothing will send.` | `This launch has no sale set up yet, so it cannot take bids. You can fill in the details below, but nothing will be sent.` |
| (nothing) | ` (the lowest price the sale allows)` |
| ` · the clearing price could not be read; the contract still enforces that your price is above it when the bid lands` | ` · the clearing price could not be read; the sale will still refuse your bid unless your price is above it` |
| `record a bid made elsewhere, bucket, who signs` | `record a bid made elsewhere, bid group, who records it` |
| `Bid made outside this page? Its transaction hash` | `Bid made outside this page? Its confirmation ID` |
| `Bucket` | `Bid group` |
| `Sign as agent instead of me` | `Record this bid under your helper instead of you` |
| `The bid record will be signed by this browser's agent key (an attested AI-agent identity) instead of your personal key. Use it when an agent manages the bid's follow-up.` | `The note of this bid will be recorded under the helper set up in this browser instead of under you. Use it when your helper looks after the bid afterwards.` |
| `judged; they do not stop a vote from spending the treasury. If the sale misses its minimum, every bid is refunded.` | `judged; they do not stop a vote from spending the project's money. If the sale misses its minimum, every bid is refunded.` |
| `The most you will spend. You pay the clearing price for what you win; the rest is refunded.` | `The most you will spend. You pay the clearing price (the going price at each moment of the sale) for what you win; the rest is refunded.` |

**`features/launchpad/ui/SalePriceCard.tsx`**

| Before | After |
|---|---|
| `<dt>Clearing price now</dt>` | `<dt>Price right now</dt>` |

**`features/launchpad/ui/TradingCard.tsx`**

| Before | After |
|---|---|
| `Sellers offer Shares they already hold, in whole lots at a lowest price, and buyers bid for whole lots at a highest one, for three days. Then anyone settles the round at one price. Unsold Shares wait for their seller to collect them, and a buyer's money above the price comes back to them. If nobody settles within two days the round is void and everyone takes back what they put in. Trading moves existing Shares between people: it does not raise money for the project, and it does not promise a next buyer.` | `A lot is a fixed bundle of Shares. The project's listing sets the lowest and highest price a lot can sell for. Sellers offer whole lots they already hold at a lowest price, and buyers bid for whole lots at a highest one, for three days. Then anyone settles the round, which works out the one price and who gets what. Unsold Shares wait for their seller to collect them, and a buyer's money above the price comes back to them. If nobody settles within two days, nothing trades and everyone takes back what they put in. Trading moves existing Shares between people: it does not raise money for the project, and it does not promise a next buyer.` |

**`features/launchpad/ui/TradingForm.tsx`**

| Before | After |
|---|---|
| `Tick the box once you have checked the bar above.` | `Tick the box once you have checked each point above.` |
| `Trading is open: Shares can be sent between wallets. A vote can lock it again at once.` | `Trading is open: Shares can be sent from one person to another. A vote can lock it again at once.` |
| `Trading was announced. It can open from ${when(state.opensAt)}, by a second vote; until then the Shares refuse it.` | `Trading was announced. A second vote can open it from ${when(state.opensAt)}; until then it stays locked.` |
| `Trading is locked: Shares cannot be sent between wallets, so nobody can sell them. Opening it takes two votes: one announces it, and the second can only run 30 days later.` | `Trading is locked: Shares cannot be sent to anyone else, so nobody can sell them. Opening it takes two votes: one announces it, and the second can only run 30 days later.` |
| `The contracts check none of this. A vote can announce trading without it; what protects holders is the 30 days, in which anyone can leave with their share of the treasury.` | `Nothing in the app's code enforces this list. A vote can announce trading without it; what protects holders is the 30 days, in which anyone can leave with their share of the project's money.` |

**`features/launchpad/ui/TradingListingForm.tsx`**

| Before | After |
|---|---|
| `Publish the DAO's listing in its secondary market, or stop new rounds. Publishing it is a vote: nothing opens until holders back it and it takes effect.` | `Publish the project's listing (the price range for its weekly market), or stop new rounds. Publishing it is a vote: nothing opens until holders back it and it takes effect.` |
| `This project has no secondary market, so there is no listing to publish.` | `This project has no market, so there is no listing to publish.` |
| `The market's price token isn't answering, so prices` | `The market's price token couldn't be read, so prices` |
| `The grid runs from the lowest price to the highest, and a round's price is one level on it. Nothing sells outside the two, however much is bid.` | `Prices run in steps from the lowest to the highest, and a round's price is one of those steps. Nothing sells outside that range, however much is bid.` |
| `How many steps the range is cut into, 1 to 64. The market refuses a range its steps do not divide evenly, so every level is a whole price.` | `How many steps the range is cut into, 1 to 64. The market refuses a range its steps do not divide evenly, so every step is a whole price.` |

**`features/launchpad/ui/WeeklyRoundsCard.tsx`**

| Before | After |
|---|---|
| `highest one, for three days. Then anyone settles it at one price: the highest at which bids still take everything offered. The price never goes below what leaving the project pays. A fifth of a seller's gain above that goes to the treasury. Anyone can still leave at any time, and if nobody settles within two days, everyone takes back what they put in.` | `highest one, for three days. Then anyone settles the round, which works out the one price and who gets what: the highest price at which buyers still take everything offered. The price never goes below the floor price, which is what leaving the project pays. A fifth of a seller's gain above that goes into the project's money. Anyone can still leave at any time, and if nobody settles within two days, everyone takes back what they put in.` |
| `` text={`You offer ${sharesText(sell.amount)} Shares at ${usdc(round.floor + BigInt(sell.step) * round.step)} or more.${over && sold ? ` Sold: ${sharesText(sold.units)} Shares, for ${usdc(sold.money)} after the cut.` : ""}${sell.claimed ? " Collected." : ""}`} `` | `` text={`You offer ${sharesText(sell.amount)} Shares at ${usdc(round.floor + BigInt(sell.step) * round.step)} or more.${over && sold ? ` Sold: ${sharesText(sold.units)} Shares, for ${usdc(sold.money)} after the project's cut.` : ""}${sell.claimed ? " Collected." : ""}`} `` |

**`features/launchpad/ui/RoundOrderForms.tsx`**

| Before | After |
|---|---|
| `Allowing…` | `Approving…` |

### Work, milestones, checks and agreed terms

**`features/launchpad/lib/acting-account.ts`**

| Before | After |
|---|---|
| `if (!account.passkeyOffered) return "Connect your wallet to act on this."` | `if (!account.passkeyOffered) return "Connect a wallet app to take part."` |
| `Set up passkey sign-in from your profile menu to act here${fees}, or add a wallet to this browser.` | `Set up passkey sign-in from your profile menu to act here${fees}, or add a wallet app to this browser.` |
| `if (account.kind === "wallet") return "Connect your wallet to act on this."` | `if (account.kind === "wallet") return "Connect a wallet app to take part."` |
| `Your passkey's signature was not accepted, so nothing was sent. Press the button again; if it happens again, tell whoever runs this site.` | `Your passkey's approval was not accepted, so nothing was sent. Press the button again; if it happens again, tell whoever runs this site.` |

**`features/launchpad/lib/agreed-lane.ts`**

| Before | After |
|---|---|
| `Agreed rewards run on their exact terms here.` | `Agreed rewards are paid on their exact terms here.` |
| `Agreed rewards on this budget use a version this screen cannot follow yet. Existing work keeps working as before; nothing is changed or held up.` | `This work budget uses a newer version of agreed rewards that this page cannot show yet. Existing work carries on as before; nothing is changed or held up.` |
| `This budget ran before agreed rewards existed, so it keeps its existing manual flow.` | `This work budget started before agreed rewards existed, so it keeps working the way it always has.` |
| `Could not read this budget's agreed rewards just now. Nothing here is left out on purpose — try again in a minute.` | `Could not read this work budget's agreed rewards just now. Nothing is hidden on purpose. Try again in a minute.` |
| `The attempt's state could not be read yet, so nothing is named as a next step here.` | `We could not read where this attempt stands yet, so no next step is shown. Try again in a moment.` |
| `dueLine: "The challenge window ends", note: "Approved on its exact terms. Once the challenge window ends, anyone can settle the agreement at its reserved quantity. Nothing can be paid inside the window."` | `dueLine: "The objection window ends", note: "Approved on its exact terms. Once the objection window ends, anyone can settle the agreement at the Shares set aside for it. Nothing is paid before then."` |

**`features/launchpad/lib/agreed-submission.ts`**

| Before | After |
|---|---|
| `A submission already exists under this attempt with different text. This award keeps that attempt; take a new agreement for different work.` | `A submission already exists under this attempt with different text. The award stays with that attempt; make a new agreement for different work.` |

**`features/launchpad/lib/agreed-terms.ts`**

| Before | After |
|---|---|
| `return { kind: "problem", problem: "Name the person's wallet address." }` | `return { kind: "problem", problem: "Enter the account address of the person.", }` |
| `A work area's manager cannot be the beneficiary of its own offer. Name someone else.` | `A work area's manager cannot receive its own offer. Name someone else.` |
| `That quantity is more than the Shares token can ever hold.` | `That is more Shares than can ever exist.` |
| `The reviewer panel this offer names could not be read.` | `The reviewers this offer names could not be read.` |
| `Every coauthor needs a wallet address.` | `Every coauthor needs an account address.` |
| `A split names each person once, and never the work area's manager.` | `Each person can be named only once, and never the work area's manager.` |
| `Leave the beneficiary a part of the quantity.` | `Leave the person the offer names a part of the Shares.` |
| `That split leaves someone less than one whole Share. Raise the quantity or the part.` | `That split leaves someone less than one whole Share. Raise the number of Shares or the part.` |
| `The split these terms commit to could not be read, so they cannot be accepted yet. Refresh in a minute.` | `The split in these terms could not be read, so they cannot be accepted yet. Refresh in a minute.` |
| `The declared split does not match what this offer committed to, so nothing was sent.` | `The split does not match what this offer says, so nothing was sent.` |
| `The declared split does not fit this quantity, so nothing was sent.` | `The split does not fit the number of Shares, so nothing was sent.` |
| `This offer commits to a split that has not been read, so it cannot be accepted yet. Refresh in a minute.` | `The split in this offer has not been read yet, so it cannot be accepted. Refresh in a minute.` |
| `Agreed; the quantity is reserved` | `Agreed; the Shares are set aside` |
| `Expired; the reservation was released` | `Expired; the Shares set aside were released` |
| `The reviewer panel could not be read just now, so how many must agree is not shown.` | `The reviewers could not be read just now, so how many must agree is not shown.` |
| `${input.quorum} of the ${input.panel} reviewers on this budget's panel must agree. Reviewing is voluntary and unpaid.` | `${input.quorum} of the ${input.panel} reviewers on this work budget must agree. Reviewing is voluntary and unpaid.` |

**`features/launchpad/lib/bounty-copy.ts`**

| Before | After |
|---|---|
| `${words.who(stage.contributor)}'s work was approved. It can be paid from ${words.date(stage.payableAt)}, unless the DAO stops it before then.` | `${words.who(stage.contributor)}'s work was approved. It can be paid from ${words.date(stage.payableAt)}, unless the project stops it before then.` |

**`features/launchpad/lib/challenge-copy.ts`**

| Before | After |
|---|---|
| `Publishing opens once buyers can claim what they bought in the sale. That has not happened yet; it opens on its own, with nothing for the team to do.` | `Publishing opens once buyers can collect what they bought in the sale. That has not happened yet. It opens on its own, with nothing for the team to do.` |
| `Holders can still object to milestone ${index} until ${deadline(opens)}, and the team's Shares still locked are what an upheld objection would burn. Milestone ${index + 1} can be published after that.` | `Holders can still object to milestone ${index} until ${deadline(opens)}. If they agree with an objection, the team's Shares that are still locked are destroyed. Milestone ${index + 1} can be published after that.` |
| `A holder objected later and holders upheld it: the team's remaining locked Shares were burned.` | `A holder objected later and holders agreed: the team's remaining locked Shares were destroyed.` |
| `Unlocked on ${date(m.unlockedAt)}. ${howItStood(m, terms)} For ${span(m.unlockedAt + terms.clawback - now)} more a holder can raise one more objection; if holders uphold it, the team's remaining locked Shares are burned.` | `Unlocked on ${date(m.unlockedAt)}. ${howItStood(m, terms)} For ${span(m.unlockedAt + terms.clawback - now)} more, a holder can raise one more objection. If holders agree with it, the team's remaining locked Shares are destroyed.` |
| `Unlocked on ${date(m.unlockedAt)}, and a holder has objected to it since. Holders vote until ${deadline(open.voteEnds)}. If it is upheld, the team's remaining locked Shares are burned.` | `Unlocked on ${date(m.unlockedAt)}, and a holder has objected to it since. Holders vote until ${deadline(open.voteEnds)}. If holders agree with it, the team's remaining locked Shares are destroyed.` |

**`features/launchpad/lib/check-runs.ts`**

Also: 1 wording tweak(s) of spelling, punctuation or capitalization only.

| Before | After |
|---|---|
| `The record's ${word} tag does not match its own text; the page binds what the record's text says, and cannot agree with both.` | `The record's ${word} label does not match its own text. This page goes by the text.` |
| `The record carries no ${word} tag.` | `The record has no ${word} label.` |
| `const claimId = bind(claim.id, "claim", "claim id"); const mandate = bind(claim.mandate, "mandate", "mandate"); const evidenceHashBound = bind(evidenceHash, "evidence", "evidence hash")` | `const claimId = bind(claim.id, "claim", "submission ID"); const mandate = bind(claim.mandate, "mandate", "work area"); const evidenceHashBound = bind( evidenceHash, "evidence", "evidence fingerprint", )` |
| `The record carries no sandbox tag.` | `The record does not say whether the checks ran in a protected space.` |
| `The record's sandbox tag and its own sandboxEnforced field disagree.` | `The record contradicts itself about whether the checks ran in a protected space.` |

**`features/launchpad/lib/enforced-check.ts`**

| Before | After |
|---|---|
| `${clause.action}: proposalThreshold unreadable. The claim stands unverified` | `${clause.action}: the minimum votes needed to propose could not be read just now. The claim stands unverified` |
| `${clause.action}: backed by proposalThreshold = ${state.proposalThreshold} (live)` | `${clause.action}: backed by the project's rule that you need at least ${state.proposalThreshold} votes to propose (checked now)` |
| `${clause.action}: claimed, but proposalThreshold = 0. Anyone may propose` | `${clause.action}: claimed, but the minimum votes needed to propose is 0. Anyone may propose` |
| `${clause.action}: ragequittable unreadable. The claim stands unverified` | `${clause.action}: whether leaving with your share is switched on could not be read just now. The claim stands unverified` |
| `${clause.action}: backed by ragequittable = true (live)` | `${clause.action}: backed by leaving with your share being switched on (checked now)` |
| `${clause.action}: claimed, but ragequittable = false. The exit right does not exist` | `${clause.action}: claimed, but leaving with your share is switched off. The right to leave does not exist` |
| `${clause.action}: gated by ${clause.checkpoint.approver ?? "human approval"} (documented policy, see the approval cards)` | `${clause.action}: needs approval from ${clause.checkpoint.approver ?? "a person"} (a stated rule, see the approval cards)` |
| `${clause.action}: mechanism "${mechanism \|\| "none"}" not checked here` | `${clause.action}: this rule (${mechanism \|\| "none"}) cannot be checked here` |

**`features/launchpad/lib/milestone-progress.ts`**

| Before | After |
|---|---|
| `Frozen. The DAO is deciding what happens to this claim.` | `Frozen. The project is deciding what happens to this submission.` |
| `"The reviewers turned this claim down. You can submit the milestone again." : "This claim is closed. You can submit the milestone again."` | `"The reviewers turned this submission down. You can submit the milestone again." : "This submission is closed. You can submit the milestone again."` |

**`features/launchpad/lib/milestone-receipt.ts`**

| Before | After |
|---|---|
| `Settlement tx hash must be 0x followed by 64 hex characters.` | `The confirmation ID must be 0x followed by 64 letters and digits (0 to 9 and a to f).` |

**`features/launchpad/lib/milestone-submission.ts`**

| Before | After |
|---|---|
| `Someone else filed a claim under this submission's name first, so it cannot be filed. Press Start over to send the same text under a new name.` | `Someone else already used this submission's name, so it cannot be sent. Press Start over to send the same text under a new name.` |
| `That claim is no longer open, so it cannot be continued. Press Start over to make a new submission.` | `That submission is no longer open, so it cannot be continued. Press Start over to make a new one.` |
| `The saved text is not what was filed with that claim. Press Start over to make a new submission.` | `The saved text is not what was sent with that submission. Press Start over to make a new one.` |
| `That claim names different words for its criterion, so it cannot be this milestone's. Press Start over to make a new submission.` | `That submission names different words for what counts as done, so it cannot be this milestone's. Press Start over to make a new one.` |
| `The connected wallet changed while this submission's name was being checked, so nothing was sent. Your text is still in the box. Submit again to send it from this wallet.` | `Your account changed while this submission's name was being checked, so nothing was sent. Your text is still in the box. Submit again to send it from this account.` |
| `Could not check with the network that this submission's name is free, so nothing was sent. Your text is still in the box. Try again in a moment.` | `Couldn't check that this submission's name is free, so nothing was sent. Your text is still in the box. Try again in a moment.` |

**`features/launchpad/lib/milestone-timeline.ts`**

| Before | After |
|---|---|
| `Approved and past the waiting period. The release can be claimed now.` | `Approved and past the waiting period. It can be released now.` |
| `` `Unlocked${input.releasedAt ? ` on ${day(input.releasedAt)}` : ""}. These tokens can now be moved.` `` | `` `Unlocked${input.releasedAt ? ` on ${day(input.releasedAt)}` : ""}. These Shares can now be moved.` `` |
| `A DAO vote froze this claim. Nothing unlocks while it is frozen.` | `A project vote froze this submission. Nothing unlocks while it is frozen.` |
| `"The reviewers turned this claim down. The team can submit the milestone again." : "This claim is closed. The team can submit the milestone again."` | `"The reviewers turned this submission down. The team can submit the milestone again." : "This submission is closed. The team can submit the milestone again."` |
| `The DAO gave these tokens up: they were burned and never released.` | `The project gave these Shares up: they were destroyed and never released.` |

**`features/launchpad/lib/post-bounty-copy.ts`**

| Before | After |
|---|---|
| `The court did not uphold the work in time. Everyone can take their money back.` | `The court did not agree with the work in time. Everyone can take their money back.` |
| `If work was filed, that waits three more days in case it goes to the court, and for as long as the court has it.` | `If work was submitted, that waits three more days in case it goes to the court, and for as long as the court has it.` |

**`features/launchpad/ui/AgreedCorrectionsForm.tsx`**

| Before | After |
|---|---|
| `Your words are published, but the request did not reach the chain. Press again to send it.` | `Your words are published, but the request did not reach the network. Press again to send it.` |

**`features/launchpad/ui/AgreedProposalForm.tsx`**

| Before | After |
|---|---|
| `Still could not publish the offer's description. The offer itself is on the chain; press again to publish the words.` | `Still could not publish the offer's description. The offer itself is saved on the network. Press again to publish the words.` |
| `The offer did not reach the chain. Nothing is reserved and nobody is bound. Press again to send it.` | `The offer did not reach the network. No Shares are set aside and nobody is committed. Press again to send it.` |
| `` `The offer is on the chain, but its description and the work area's words could not be published (${ `` | `` `The offer is saved on the network, but its description and the work area's words could not be published (${ `` |
| `The offer is on the chain, but its description and the work area's words are not published yet, so the person it names cannot read what it is for.` | `The offer is saved on the network, but its description and the work area's words are not published yet, so the person it names cannot read what it is for.` |
| `Promise one exact quantity of Shares for one deliverable before the work starts. The person it names accepts, and the quantity is reserved then — not before.` | `Promise an exact number of Shares for one deliverable before the work starts. The person you name accepts, and the Shares are set aside then, not before.` |
| `One deliverable, one offer. Its exact words become the slot this offer is bound to.` | `One deliverable, one offer. Its exact words tie this offer to that one piece of work.` |
| `These are the work area's published words, checked against the chain.` | `These are the work area's published words, checked against the network.` |
| `Their wallet address` | `Their account address` |
| `quantity. Parts are fixed by both signatures and cannot be added to later.` | `quantity. Parts are fixed once both sides approve, and cannot be added to later.` |
| `Coauthor {index + 1} wallet` | `Coauthor {index + 1} account address` |

**`features/launchpad/ui/AgreedRewardsSection.tsx`**

| Before | After |
|---|---|
| `Work whose exact reward is promised before it starts. The quantity is fixed in Shares, not in money and not as a percentage of the project, and it settles on those terms without a new award vote.` | `Work whose exact reward is promised before it starts. The reward is a fixed number of Shares, not money and not a percentage of the project. It is paid on those terms without a new award vote.` |
| `assumed about whether it has them. Its existing manual flow is unchanged.` | `assumed about whether it has them. Its existing process is unchanged.` |
| `{mandate.isMilestonePanel ? "Milestone panel" : "Work budget"}` | `{mandate.isMilestonePanel ? "Milestone reviewers" : "Work budget"}` |
| `just now, so they are not shown. Their on-chain terms are below.` | `just now, so they are not shown. Their terms, as recorded on the network, are below.` |

**`features/launchpad/ui/AgreedSubmissionForm.tsx`**

| Before | After |
|---|---|
| `Could not read the chain for this attempt just now. Nothing was published; try again.` | `Couldn't read this attempt from the network just now. Nothing was published. Try again.` |
| `The chain holds different text under this attempt, so this copy is not published over it. Leave the form as it is, or ask the project's manager to look at the attempt id below.` | `The network holds different text for this attempt, so this copy was not published over it. Leave the form as it is, or ask the project's manager to look at the attempt ID below.` |
| `Could not read the chain for this attempt just now, so nothing was sent. Try again.` | `Couldn't read this attempt from the network just now, so nothing was sent. Try again.` |
| `The send to the chain did not finish. Nothing was lost. Press again to send what is still missing, under the same attempt.` | `Sending to the network did not finish. Nothing was lost. Press again to send what is still missing, under the same attempt.` |
| `Your work landed, but its evidence could not be published, and reviewers cannot approve what they cannot read. Press Publish the evidence again to press the words through.` | `Your work was sent, but its evidence could not be published, and reviewers cannot approve what they cannot read. Press Publish the evidence again to try once more.` |
| `The attempt went to the chain, but its evidence could not be published: reviewers cannot approve what they cannot read. A copy is kept in this browser.` | `The attempt was sent to the network, but its evidence could not be published, and reviewers cannot approve what they cannot read. A copy is kept in this browser.` |
| `This attempt asks for no money: the agreed quantity of Shares is already reserved. One press sends the claim, its check and its binding in order.` | `This attempt asks for no money: the agreed Shares are already set aside. One press sends the submission, the words it is judged against, and its link to the agreement, in order.` |
| `The attempt names its own id on the chain` | `The attempt's own ID on the network` |

**`features/launchpad/ui/AgreedTermsCard.tsx`**

| Before | After |
|---|---|
| `Its record did not come back in a shape this page can show. Nothing is assumed about it.` | `Its record came back in a form this page can't show, so nothing is shown about it.` |
| `The exact quantity` | `The exact number of Shares` |
| `The split these terms commit to could not be read, so who receives the quantity is not shown here. Refresh in a minute.` | `The split in these terms could not be read, so who receives the Shares is not shown here. Refresh in a minute.` |
| `{index === 0 ? " (the beneficiary)" : ""}:` | `{index === 0 ? " (the person named)" : ""}:` |
| `The parts add up to the exact quantity; rounding dust goes to the beneficiary. These recipients are fixed by both signatures and cannot be added to later.` | `The parts add up to the exact number of Shares. Any rounding leftover goes to the person named. These recipients are fixed once both sides approve, and cannot be added to later.` |
| `bound, and anyone may release the reservation.` | `linked to this agreement, and anyone may release the Shares set aside.` |
| `<dt>The panel</dt>` | `<dt>The reviewers</dt>` |
| `These are the keys this budget records, not a claim about who is behind them.` | `These are the accounts this work budget lists, not a statement about who is behind them.` |
| `offer's own slot, so it is not shown as its terms.` | `offer, so it is not shown as its terms.` |
| `The panel reached its actual quorum. Finishing the review on the submission starts the challenge window; nothing is paid before it` | `Enough reviewers approved it. Finishing the review on the submission starts the objection window. Nothing is paid before it` |
| `The panel reached its quorum against this attempt, so nothing is paid for it. After its review ends, anyone may close it as lapsed, and the reservation then releases by explicit action.` | `Enough reviewers turned this attempt down, so nothing is paid for it. After its review ends, anyone may close it as lapsed, which releases the Shares set aside.` |
| `{labelOf(terms.beneficiary)} accepts it from the wallet it names. Accepting is when the quantity is reserved.` | `{labelOf(terms.beneficiary)} accepts it from the account it names. The Shares are set aside when it is accepted.` |
| `Release the reservation` | `Release the Shares set aside` |

**`features/launchpad/ui/ChallengeMilestoneCard.tsx`**

| Before | After |
|---|---|
| `"be upheld: the team's remaining locked Shares would be burned." : "be upheld: the milestone would be turned down." : "not be upheld: the milestone would stand."}` | `"be agreed with: the team's remaining locked Shares would be destroyed." : "be agreed with: the milestone would be turned down." : "not be agreed with: the milestone would stand."}` |
| `This is the text the team committed to on the network: it matches, and it is judged against the milestone's words above.` | `This is the text the team recorded on the network. It matches, and it is judged against the milestone's words above.` |
| `team submitted to the lock. Do not rely on it.` | `team recorded. Do not rely on it.` |
| `The team has not published text matching what it submitted to the lock. Holders cannot judge what they cannot read.` | `The team has not published text matching what it recorded. Holders cannot judge what they cannot read.` |
| `"This milestone has already unlocked. If holders uphold your objection, the team's remaining locked Shares are burned and its bond is forfeited; what already unlocked stays unlocked." : "If holders uphold your objection, the milestone is turned down and the team has to try again with a longer window."}` | `"This milestone has already unlocked. If holders agree with your objection, the team's remaining locked Shares are destroyed and its bond is lost. What already unlocked stays unlocked." : "If holders agree with your objection, the milestone is turned down and the team has to try again with a longer window."}` |
| `You post a deposit of ${money(deposit)}. You get it back, with half of the team's bond, if holders uphold your objection. If they do not, it goes to the DAO.` | `You put down a deposit of ${money(deposit)}. If holders agree with your objection, you get it back plus half of the team's bond. If they do not, the deposit goes to the project.` |

**`features/launchpad/ui/ChallengeMilestones.tsx`**

| Before | After |
|---|---|
| `{money(terms.bond)}.` | `{money(terms.bond)}. A bond is a deposit the team loses if holders turn the milestone down.` |
| `possible. If holders uphold it, the team's remaining locked Shares are burned.` | `possible. If holders agree with it, the team's remaining locked Shares are destroyed.` |
| `ahead stay locked, and are burned, while an earlier milestone can be objected to. Once the last one has unlocked, what stands behind it is the bond.` | `ahead stay locked, and can be destroyed, while an earlier milestone can be objected to. Once the last one has unlocked, what stands behind it is the bond.` |
| `Backers can still leave with their share of the treasury while a milestone waits.` | `Backers can still leave with their share of the project's money while a milestone waits.` |
| `Holders can still vote to spend the treasury or to issue more Shares or non-voting shares, and those votes do not wait for milestones.` | `Holders can still vote to spend the project's money or to issue more Shares or non-voting shares, and those votes do not wait for milestones.` |

**`features/launchpad/ui/ChecksRunSection.tsx`**

| Before | After |
|---|---|
| `This page does not know which mandate this submission is bound to, so it shows nothing rather than whatever results carry a matching claim id. Binding to the project comes first; results are matched after.` | `This submission is not linked to a project yet, so no check records are shown. Showing records that only share its ID could be wrong. They appear once it is linked.` |
| `No published check records matched this submission in what this page asked for. The page cannot tell whether the declared checks were run at all — a published record is the only sign of that. You can ask the contributor to run their declared checks and publish the record.` | `No published check records match this submission. This page cannot tell whether the checks the contributor named were run: a published record is the only sign of that. You can ask the contributor to run them and publish the record.` |
| `No published check record bound this submission — none matched this claim's mandate, its claim id and its evidence hash together. What the page found named the claim without binding it, so nothing is shown as its result.` | `No published check record is tied to this submission: none matched its work area, its ID and its evidence together. Some records mention it without matching all three, so none is shown as its result.` |
| `carried this claim id under another mandate — another project or market — and is not shown: matching by id alone would be a guess.` | `carried this submission's ID under another work area (another project or market). It is not shown: matching on the ID alone would be a guess.` |
| `named this claim but ran against other evidence than what the submission committed to, and is not shown with it.` | `named this submission but ran against different evidence than the submission recorded. It is not shown with it.` |
| `These records are the publisher's own runs of the declared checks — not verification by anyone else. Read them beside the work; they do not replace your verdict.` | `These records are the publisher's own runs of the checks, not a check by anyone else. Read them beside the work. They do not replace your verdict.` |
| `named this claim but ran against other evidence and is not shown with this submission.` | `named this submission but ran against different evidence. It is not shown with this one.` |
| `carried this claim id under another mandate and is not counted here.` | `carried this submission's ID under another work area. It is not counted here.` |
| `What the newest run's checks add up to: {counts.passed} passed · {counts.failed} failed · {counts.timedOut} timed out · {counts.notRun} not run · {counts.auxiliary} extra · {counts.contradicted} self-contradicted.` | `Totals for the newest run: {counts.passed} passed · {counts.failed} failed · {counts.timedOut} timed out · {counts.notRun} not run · {counts.auxiliary} extra · {counts.contradicted} contradicting themselves.` |
| `"The record's own summary matches that." : "The record's own summary does NOT match: the counts above are worked out from the checks list, and the claimed summary is not trusted."}` | `"The record's own summary agrees." : "The record's own summary does NOT agree. The totals above are counted from the list of checks, and the record's summary is not trusted."}` |
| `The record says passed but it exited ${check.exitStatus} — treat it as neither pass nor evidence; it is counted as self-contradicted` | `The record says passed, but the check ended with exit code ${check.exitStatus}. Treat it as neither a pass nor evidence; it counts as contradicting itself` |
| ` · exited ${check.exitStatus}` | ` · exit code ${check.exitStatus}` |
| `{check.argvCut ? " …(more arguments than the page holds)" : ""}` | `{check.argvCut ? " …(more than this page shows)" : ""}` |
| `Other checks (outside the accepted criteria)` | `Other checks (not part of what counts as done)` |
| `"no criterion was recorded for it anyway" : "its criterion hash is not what this claim commits to, so it counts as extra"}` | `"nothing was recorded about what it checks, anyway" : "what it checks is not what this submission recorded, so it counts as extra"}` |
| `The publisher reports the checks were confined (sandbox: enforced). That is their report, not a remote check — the page cannot attest the container. It does not say the work is good: only your verdict does.` | `The publisher says the checks ran in a protected space. That is their report, and this page cannot confirm it. It does not say the work is good: only your verdict does.` |
| `"The record's own sandbox report says the checks were not verified as confined (sandbox: unchecked) — as far as this record says, the checks ran unconfined, or did not run at all. Whatever it lists as passed is the publisher's word; read the output yourself." : "The record says nothing certain about confinement (no sandbox claim attached), so the checks may have run unconfined. Whatever it lists as passed is the publisher's word; read the output yourself."}` | `"The record says the checks were not confirmed to run in a protected space, so they may have run without protection, or not at all. Whatever it lists as passed is the publisher's word; read the output yourself." : "The record does not say whether the checks ran in a protected space, so they may have run without protection. Whatever it lists as passed is the publisher's word; read the output yourself."}` |
| `Model interpretation — commentary only` | `AI commentary: opinion only` |
| `The signature says who signed; the record is their word. A check-run record does not name a chain: it binds the mandate, the claim id and the evidence hash its publisher tagged, on whatever network they signed it in.` | `The signature shows who published it. The record is their word. It does not say which network it was made on; it is tied to the work area, submission ID and evidence its publisher labelled.` |

**`features/launchpad/ui/ClaimPaidLine.tsx`**

| Before | After |
|---|---|
| `Paid; its payout transaction was not found in the history this page reads.` | `Paid. We could not find the payment in the records this page reads. Refresh in a moment.` |
| `Finished; its transaction was not found in the history this page reads.` | `Finished. We could not find the step in the records this page reads. Refresh in a moment.` |

**`features/launchpad/ui/ClaimSideNotes.tsx`**

| Before | After |
|---|---|
| `"This work was agreed in advance, so its exact quantity settles from the agreement, not from a vote." : "Could not check whether this work was agreed in advance, so no award vote is offered here. Refresh the page to check."}` | `"This work was agreed in advance, so its exact number of Shares comes from the agreement, not from a vote." : "Couldn't check whether this work was agreed in advance, so no award vote is offered here. Refresh the page to check again."}` |
| `This work carries no agreed reward: awarding Shares for it is a discretionary decision the DAO votes on.` | `This work has no agreed reward. Awarding Shares for it is a judgment call that the project votes on.` |
| `This submission belongs to an agreed reward; its beneficiary binds it from the agreement above.` | `This submission belongs to an agreed reward. The person named in the agreement above links it to that agreement.` |

**`features/launchpad/ui/ContributionsTab.tsx`**

| Before | After |
|---|---|
| `<span>Its evidence was not found in the history this page read.</span>` | `<span>Its evidence was not found in the records this page read.</span>` |
| `<span>Its evidence is on the Work tab with the claim.</span>` | `<span>Its evidence is on the Work tab with the submission.</span>` |
| `This DAO has more work budgets or awards than this page reads; the oldest are shown.` | `This project has more work budgets or awards than this page reads. The oldest are shown.` |
| `your part of what the treasury holds now; it does not protect your share of the project.` | `your part of the money the project holds now. It does not protect your share of the project.` |

**`features/launchpad/ui/EnforcementCard.tsx`**

| Before | After |
|---|---|
| `No enforcement register published yet, so nothing is claimed and nothing is checked.` | `This project has not published a list of what its rules guarantee yet, so there is nothing to check.` |
| `What this org says it enforces, checked against live contract config. A claim the chain contradicts is shown as contradicted. The register is a claim; this card is the check.` | `What this project says its rules guarantee, checked against the rules it runs on right now. If those rules say otherwise, the line is shown as contradicted. The published list is only a statement; this card is the check.` |

**`features/launchpad/ui/EvidenceBlock.tsx`**

| Before | After |
|---|---|
| `The hash matches what this submission committed to, so this is the evidence as it was filed. That says nothing about whether it is true — read it before you judge.` | `Its fingerprint matches what this submission recorded, so this is the evidence as it was submitted. That does not show it is true. Read it before you judge.` |

**`features/launchpad/ui/FileClaimCard.tsx`**

| Before | After |
|---|---|
| `The milestone panel (for your team's milestones)` | `Milestone reviewers (for your team's milestones)` |

**`features/launchpad/ui/MilestoneRow.tsx`**

| Before | After |
|---|---|
| `file: "file the claim", check: "state which milestone it is for"` | `file: "record the submission", check: "say which milestone it is for"` |
| `"This launch's record does not have the milestone's words, so it cannot be submitted from here." : "This launch has no milestone panel to submit to."}` | `"This project's record is missing the milestone's words, so it can't be submitted from here." : "This project has no milestone reviewers to submit to."}` |

**`features/launchpad/ui/MilestoneSummaryCard.tsx`**

| Before | After |
|---|---|
| `How they are judged: holders can object. The team publishes evidence and posts a bond; its Shares unlock after the objection period (${span(lock.terms.window)} to start with, longer for a bigger milestone or a retry) unless holders successfully challenge the claim. Milestones go in order, each only once the one before has had its time for late objections.` | `How they are judged: holders can object. The team publishes evidence and posts a bond (a deposit the team loses if holders turn the milestone down); its Shares unlock after the objection period (${span(lock.terms.window)} to start with, longer for a bigger milestone or a retry) unless holders object successfully. Milestones go in order, each only once the one before has had its time for late objections.` |

**`features/launchpad/ui/MilestonesTab.tsx`**

| Before | After |
|---|---|
| `, ${formatShares(summary.givenUp)} given up by the DAO` | `, ${formatShares(summary.givenUp)} given up by the project` |
| `. {panel.quorum} must agree on a milestone. The panel is fixed when the project launches: nobody can swap in friendlier reviewers later` | `. {panel.quorum} must agree on a milestone. The reviewers are fixed when the project launches: nobody can swap in friendlier ones later` |
| `Holders can still vote to spend the treasury or to issue more Shares or non-voting shares, and those votes do not wait for milestones.` | `Holders can still vote to spend the project's money or to issue more Shares or non-voting shares, and those votes do not wait for milestones.` |
| `This is the text the claim committed to: the hash matches, so this is the packet as it was stored. A matching hash does not prove what the packet says.` | `This is the text the submission recorded. Its fingerprint matches, so it is exactly what was stored. A match does not prove that what it says is true.` |
| `No evidence matching this claim could be found. Reviewers cannot approve what they cannot read.` | `No evidence matching this submission could be found. Reviewers cannot approve what they cannot read.` |
| `Open the claim on the Work tab` | `Open the submission on the Work tab` |

**`features/launchpad/ui/PostBountyForms.tsx`**

| Before | After |
|---|---|
| `Your wallet holds ${money(balance)}, less than that.` | `Your account holds ${money(balance)}, less than that.` |
| `{busy !== null ? "Waiting for your wallet…" : label}` | `{busy !== null ? "Waiting for your approval…" : label}` |
| `Your wallet holds {money(balance)}.` | `Your account holds {money(balance)}.` |
| `is paid. If none is, everyone gets their money back. Your wallet asks twice: once to allow the amount, once to put it in.` | `is paid. If none is, everyone gets their money back. You approve twice: first to let it take that amount, then to put it in.` |

**`features/launchpad/ui/ProjectDeliveryOverview.tsx`**

| Before | After |
|---|---|
| `Work budgets & claims` | `Work budgets & submissions` |
| `Money & spending authority` | `Money & spending approval` |
| `Reading the next milestone from the chain…` | `Reading the next milestone from the network…` |
| ` · Claim noted by ${nameOf(t.linkedBy ?? t.author)}. Not approved or paid yet.` | ` · Submission noted by ${nameOf(t.linkedBy ?? t.author)}. Not approved or paid yet.` |

**`features/launchpad/ui/TrackRecordCard.tsx`**

| Before | After |
|---|---|
| `tx {truncatePubkey(tx)} (malformed, not linkable)` | `confirmation ID {truncatePubkey(tx)} (unreadable, no link)` |
| `This network has no public page for transactions, so only its id is shown.` | `Only the record's ID is shown. Keep it if you need to look the record up later.` |
| `What the feed has actually recorded: milestone verdicts and claims (the verdict word is <code>approve</code> or <code>reject</code>), settlement receipts with their tx, and the community's contribution reviews. These are outcomes, not a rating. Each figure can be traced to what it was counted from, and a check that cannot be made says so.` | `What has actually been recorded: milestone verdicts and submissions (the verdict is <code>approve</code> or <code>reject</code>), payment receipts with their confirmation IDs, and the community's contribution reviews. These are outcomes, not a rating. Each figure can be traced to what it was counted from, and a check that cannot be made says so.` |
| `Strengthen your proof line: record a milestone claim or a verdict from the launch's Manage tab and it appears here with its settlement tx. The chain remains the ledger. This card only repeats what the feed says.` | `To build your track record, record a milestone submission or a verdict from the project's Manage tab. It then appears here with its confirmation ID. The network's public record is the source of truth; this card only repeats it.` |
| `No milestone verdicts or claims on this launch.` | `No milestone verdicts or submissions on this project.` |
| `settled on-chain` | `settled on the network` |
| `claim recorded, awaiting verdict` | `submission recorded, awaiting verdict` |
| `Claim by {names(entry.claim.author)} ·` | `Submitted by {names(entry.claim.author)} ·` |
| `evidence hash missing or malformed` | `evidence fingerprint missing or unreadable` |
| `No claim mirror for this milestone. A verdict arrived without one.` | `No submission is recorded for this milestone, but a verdict arrived without one.` |
| `Contribution records belong to the whole community, not one launch, so these counts cover everyone here. When a record is updated, the newer version replaces the older one instead of counting twice.` | `Contribution records belong to the whole community, not one project, so these counts cover everyone here. When a record is updated, the newer version replaces the older one instead of counting twice.` |

**`features/launchpad/ui/WorkAreaBounties.tsx`**

| Before | After |
|---|---|
| `Your wallet holds ${money(balance)}, less than that.` | `Your account holds ${money(balance)}, less than that.` |
| `Your wallet holds {money(balance)}.` | `Your account holds {money(balance)}.` |
| `Waiting for your wallet…` | `Waiting for your approval…` |
| `{waitDays(window)} wait; if none is, it comes back to you. Your wallet asks twice: to allow the amount, then to put it in.` | `{waitDays(window)} wait; if none is, it comes back to you. You approve twice: first to let it take that amount, then to put it in.` |

**`features/launchpad/ui/WorkBudgetForm.tsx`**

| Before | After |
|---|---|
| `That address does not look like a token on this chain.` | `That address does not look like a token on this network.` |
| `Shares the DAO may award from this budget, in all.` | `The most Shares the project may award from this budget, in all.` |
| `Optional. Money moves from the treasury into the budget now.` | `Optional. This money moves from the project's money into the budget now.` |
| `Optional. Each reviewer posts this before judging a submission. The DAO can take it after a disputed approval, so judging carelessly costs them. Leave empty for none.` | `Optional. Each reviewer posts this before judging a submission. The project can take it after a disputed approval, so judging carelessly costs them. Leave empty for none.` |

**`features/launchpad/ui/WorkTab.tsx`**

| Before | After |
|---|---|
| `import { BudgetFigures } from "./BudgetFigures"` | `import { BudgetFigures, BondNote } from "./BudgetFigures"` |
| `Nothing has been set aside for work yet. A work budget is created by a vote of the DAO.` | `Nothing has been set aside for work yet. A vote of the project's holders sets up a work budget: a limit on the Shares and money that can be awarded for work.` |
| `This DAO has more work than is shown here. The newest is listed.` | `This project has more work than is shown here. The newest is listed.` |
| `{mandate.isMilestonePanel ? "Milestone panel" : "Work budget"}` | `{mandate.isMilestonePanel ? "Milestone reviewers" : "Work budget"}` |
| `You are a reviewer here. Post a bond of {bondMoney(owes)} before you judge a claim. You can ask for it back later; it stays at risk for 14 days after you do.` | `You are a reviewer here. Post a bond of {bondMoney(owes)} (a deposit you lose if you approve carelessly) before you judge a submission. You can ask for it back later, but it stays at risk for 14 days after you do.` |
| `The panel's answers stand against this attempt` | `The reviewers' answers stand against this attempt` |
| `. It is not finished here; once that ends, anyone can close it as lapsed and the reservation releases.` | `. It is not finished here. Once that ends, anyone can close it as lapsed and what was set aside for it is released.` |
| `. This is the wallet that submitted the work; changing a profile wallet cannot redirect it.` | `. This is the account that submitted the work. Changing the payment account on a profile cannot redirect it.` |

**`features/launchpad/ui/enforcement-forms.tsx`**

| Before | After |
|---|---|
| `the milestone panel` | `the milestone reviewers` |
| `Close a work budget early. No new work can be submitted in it and the money not set aside for a submission goes back to the DAO. Submissions whose money is already set aside keep their own payment rules. The milestone panel is not offered here: closing it would leave the team's locked Shares with no way to unlock.` | `Close a work budget early. No new work can be submitted in it and the money not set aside for a submission goes back to the project. Submissions whose money is already set aside keep their own payment rules. The milestone reviewers are not offered here: closing it would leave the team's locked Shares with no way to unlock.` |
| `Take some of a reviewer's bond after an approval you dispute. It is paid to the DAO. This includes bond a reviewer has asked to take back but has not received yet: it stays at risk until they do. No more than the reviewer holds can be taken.` | `Take some of a reviewer's bond after an approval you dispute. A bond is the deposit a reviewer put down. What is taken goes to the project. This includes bond a reviewer has asked to get back but has not received yet: it stays at risk until they do. No more than the reviewer holds can be taken.` |

**`features/launchpad/ui/ChallengeLockedCard.tsx`**

| Before | After |
|---|---|
| `These Shares are yours and count when the DAO votes. The part tied to a milestone cannot be sold or taken out of the DAO until that milestone is reached. You publish each milestone on the Milestones tab; holders then have time to object.` | `These Shares are yours and count when the project votes. The part tied to a milestone cannot be sold or taken out of the project until that milestone is reached. You publish each milestone on the Milestones tab; holders then have time to object.` |

### Decisions, voting, court, trust and project rules

**`features/launchpad/lib/court-copy.ts`**

| Before | After |
|---|---|
| `Stake at least ${seat} CREATE: one seat.` | `Put down at least ${seat} CREATE: one seat, the smallest deposit a juror can hold.` |
| `Take out all of it, or leave at least ${seat} CREATE: one seat.` | `Take out all of it, or leave at least ${seat} CREATE: one seat, the smallest deposit a juror can hold.` |
| `if (staked === 0n) return "You have nothing staked."` | `if (staked === 0n) return "You have no deposit in the court."` |
| `You stake ${formatUnits(staked, 18)} CREATE: ${seats} ${seats === 1n ? "seat" : "seats"}, ${free} free.` | `Your deposit is ${formatUnits(staked, 18)} CREATE: ${seats} ${seats === 1n ? "seat" : "seats"}, ${free} free.` |

**`features/launchpad/lib/dao-guarantees.ts`**

| Before | After |
|---|---|
| `at least ${span(notice.full)} for anything that spends the treasury or changes the rules, ${span(notice.bounded)} for an award or a project inside a budget already voted` | `at least ${span(notice.full)} for anything that spends the project's money or changes the rules, ${span(notice.bounded)} for an award or a project inside a budget already voted` |
| `` `With this DAO's settings today, every decision waits before it takes effect: ${numbers}.` : `The DAO starts out with every decision waiting ${numbers}.` `` | `` `With this project's settings today, every decision waits before it takes effect: ${numbers}.` : `The project starts out with every decision waiting ${numbers}.` `` |

**`features/launchpad/lib/dao-overview.ts`**

| Before | After |
|---|---|
| `"You are one of the reviewers for the team's milestones. Post your bond before you judge one." : "You are a reviewer on a work budget. Post your bond before you judge a submission.", action: "Post your bond"` | `"You are one of the reviewers for the team's milestones. Put down your bond before you judge one. A bond is a deposit you lose if you act carelessly." : "You are a reviewer on a work budget. Put down your bond before you judge a submission. A bond is a deposit you lose if you act carelessly.", action: "Put down your bond"` |
| `You cannot judge anything until your bond is posted.` | `You cannot judge anything until you put down your bond.` |
| `"Anyone can now close this unanswered submission and return its stake and reserved payment." : "After its deadline, anyone can close an unanswered submission and return its stake and reserved payment."` | `"Anyone can now close this unanswered submission and return its deposit and the payment set aside for it." : "After its deadline, anyone can close an unanswered submission and return its deposit and the payment set aside for it."` |
| `Your milestone claim “${label}” is filed but not yet submitted to the milestone panel.` | `Your milestone submission “${label}” is saved but not yet sent to the milestone reviewers.` |
| `The work of ${who(claim.record.contributor)} is done. The DAO can vote to award Shares for it.` | `The work of ${who(claim.record.contributor)} is done. Shareholders can vote to award Shares for it.` |

**`features/launchpad/lib/org-diag-copy.ts`**

| Before | After |
|---|---|
| (nothing) | `New wording added: orchestration-drift / Waiting for permission / Actions that had to wait for someone to approve them. / semantic-misalignment / Work taken back / Posts or drafts that were withdrawn after the fact. / security-trust-gaps / Access removed / Moments when someone's access or standing was taken away. / cascading-effects / Knock-on activity / A burst of activity right after something was withdrawn. / systemic-complexity / Repeated rewrites` |

**`features/launchpad/lib/record.ts`**

| Before | After |
|---|---|
| `Frozen by the DAO while it is checked. Nothing is paid meanwhile.` | `Frozen by the project while it is checked. Nothing is paid meanwhile.` |
| `Unwound by the DAO after it was frozen.` | `Frozen, then undone by the project. The contributor got their deposit back and the set-aside payment returned to the project.` |
| `The DAO gave up ${labels.shares(tranche.amount)} Shares that ${who} had not earned yet.` | `The project took back ${labels.shares(tranche.amount)} Shares that ${who} had not earned yet.` |
| `This DAO has more work than is shown here. Only the newest is counted, so the totals can be too low.` | `This project has more work than is shown here. Only the newest is counted, so the totals can be too low.` |
| `Nobody's Shares are held back behind milestones in this DAO, so the team can sell theirs whenever they like.` | `Nobody's Shares are held back behind milestones in this project, so the team can sell theirs whenever they like.` |

**`features/launchpad/lib/trust-signals.ts`**

| Before | After |
|---|---|
| `Milestone claims recorded` | `Milestone submissions recorded` |
| `Milestones settled (claim + verdict, well-formed tx)` | `Milestones settled (submission, verdict and a valid payment record)` |
| `Receipts with a well-formed settlement tx` | `Receipts with a valid payment record` |
| `Receipts with a malformed tx` | `Receipts with a damaged payment record` |
| `Verdict mirrors unreadable` | `Verdict copies that could not be read` |
| `Claim mirrors unreadable` | `Submission copies that could not be read` |
| `Sweep receipts` | `Receipts for the money raised when the sale ended` |
| `Lock receipts` | `Receipts for money set aside to back the price floor` |
| `Ragequit receipts` | `Receipts for leaving with a share` |
| `Other receipt words` | `Other receipts` |

**`features/launchpad/lib/vote-control.ts`**

| Before | After |
|---|---|
| `` `${who} holds ${percentOf(weight, control.votingSupply)} of the votes that count today. A decision that spends the treasury or changes the rules needs ${turnoutPct(full)} of those votes to take part and ${pct(full.approvalBps)} of the votes cast in favour; an award or a work area inside a budget already voted needs ${turnoutPct(bounded)} and ${pct(bounded.approvalBps)}${governor.minYes > 0n ? `. Either needs at least ${shares(governor.minYes)} votes in favour` : ""}.` `` | `` `${who} holds ${percentOf(weight, control.votingSupply)} of the votes that count today. A decision that spends the project's money or changes the rules needs ${turnoutPct(full)} of those votes to take part and ${pct(full.approvalBps)} of the votes cast in favour; an award or a work area inside a budget already voted needs ${turnoutPct(bounded)} and ${pct(bounded.approvalBps)}${governor.minYes > 0n ? `. Either needs at least ${shares(governor.minYes)} votes in favour` : ""}.` `` |
| `No decision that spends the treasury or changes the rules can pass now: the DAO's minimum turnout is more than all the votes that count.` | `No decision that spends the project's money or changes the rules can pass now: the project's minimum turnout is more than all the votes that count.` |
| `No single holder can pass a decision that spends the treasury or changes the rules alone, but ${who} can pass an award or a work area ${small === "alone" ? "even against everyone" : "that nobody else votes on"}.` | `No single holder can pass a decision that spends the project's money or changes the rules alone, but ${who} can pass an award or a work area ${small === "alone" ? "even against everyone" : "that nobody else votes on"}.` |
| `${shares(control.waiting)} Shares bought in the sale are still waiting to be claimed and vote only once they are; with all of them claimed, ${who} would hold ${percentOf(weight, control.votingSupply + control.waiting)}.` | `${shares(control.waiting)} Shares bought in the sale are still waiting to be collected and vote only once they are; with all of them collected, ${who} would hold ${percentOf(weight, control.votingSupply + control.waiting)}.` |

**`features/launchpad/ui/CourtCaseCard.tsx`**

| Before | After |
|---|---|
| `This wallet's signature doesn't open the seal, and this browser has no key for it. Paste the vote key you copied when you sealed, or use the browser you sealed in.` | `Your approval doesn't open the seal, and this browser has no key for it. Paste the vote key you copied when you sealed, or use the browser you sealed in.` |
| ` · a bounty's claim ${kase.about.claim}` | ` · a bounty's submission ${kase.about.claim}` |
| `The claim could not be read.` | `The submission could not be read.` |
| `Round {kase.rounds} of 3 · {kase.round.seats} seats · {kase.round.committed} of {kase.round.drawn.length} sealed · {kase.round.revealed} opened` | `Round {kase.rounds} of 3 · {kase.round.seats} {kase.round.seats === 1 ? "seat" : "seats"} · {kase.round.committed} of {kase.round.drawn.length} {kase.round.drawn.length === 1 ? "juror has" : "jurors have"} sealed their vote · {kase.round.revealed} opened` |
| `Your wallet signs a message to seal the vote; nobody sees which way you voted until the votes are opened. This browser keeps the key that` | `You approve a message to seal your vote. Nobody sees which way you voted until the votes are opened. This browser keeps the key that` |

**`features/launchpad/ui/CourtPage.tsx`**

| Before | After |
|---|---|
| `People stake CREATE to judge disputes about work, against the words written before it started. Jurors who vote with the final ruling are paid; those who vote against it, or never open their vote, lose part of their stake.` | `Jurors are people who put down a deposit in CREATE, the court's deposit token, to judge disputes about work against the words written before it started. Jurors who vote with the final ruling are paid. Those who vote against it, or never open their vote, lose part of their deposit.` |
| `You have ${formatUnits(side.create, 18)} CREATE to stake.` | `You have ${formatUnits(side.create, 18)} CREATE to put down.` |
| `Each {formatUnits(data.seatStake, 18)} CREATE you stake is one seat. Seats are drawn at random by stake; a seat on a case is held until it is settled.` | `Each {formatUnits(data.seatStake, 18)} CREATE you put down is one seat, the smallest deposit a juror can hold. Jurors are drawn at random, weighted by how much each has put down. A seat on a case stays held until the case is settled.` |
| `"Staking…" : "Stake"}` | `"Adding…" : "Add deposit"}` |
| `Withdraw what I'm owed` | `Collect what I'm owed` |
| `Allowing…` | `Approving…` |

**`features/launchpad/ui/DaoOverview.tsx`**

| Before | After |
|---|---|
| `${((Number(holdings.data.yourShares) / Number(holdings.data.sharesInAll)) * 100).toFixed(1)}% of the DAO` | `${((Number(holdings.data.yourShares) / Number(holdings.data.sharesInAll)) * 100).toFixed(1)}% of the project` |
| `In the treasury` | `Project money` |
| `What the DAO holds now. Money already set aside for work is not counted.` | `What the project holds now. Money already set aside for work is not counted.` |
| `What this DAO has paid and to whom, and how much of its team's` | `What this project has paid and to whom, and how much of its team's` |

**`features/launchpad/ui/DecisionCard.tsx`**

| Before | After |
|---|---|
| `This pays straight out of the treasury. No reviewer checks anything before it goes.` | `This pays straight out of the project's money. No reviewer checks anything before it goes.` |
| `back it, for {duration(rules.hold)} in a row. It then waits {duration(rules.delay)} before it can take effect. Voting closes {deadline(Number(rules.expiresAt))}.` | `back it, and that holds for {duration(rules.hold)} without a break. It then waits {duration(rules.delay)} before it can take effect. Voting closes {deadline(Number(rules.expiresAt))}.` |

**`features/launchpad/ui/DecisionComposer.tsx`**

| Before | After |
|---|---|
| `After an approval you dispute. It is paid to the DAO.` | `For an approval you dispute. A bond is the deposit a reviewer put down. It goes to the project.` |
| `Let Shares be sent between wallets, and so bought and sold. It can open only 30 days after a vote announces it.` | `Let people send Shares to each other, so they can be bought and sold. It can open only 30 days after a vote announces it.` |
| `Publish a secondary market listing` | `Publish a weekly market listing` |
| `Let holders offer Shares and buyers bid, between a lowest and a highest price. Turning it off opens no round and takes no new offer or bid; settlement and claims carry on.` | `Let holders offer Shares and buyers bid, between a lowest and a highest price. Turning it off starts no new round and takes no new offer or bid. Rounds already open still settle, refund and pay out.` |
| `Share revenue with everyone holding Shares or non-voting shares, or pay them from the treasury.` | `Share revenue with everyone holding Shares or non-voting shares, or pay them from the project's money.` |
| `Pay from the treasury` | `Pay from the project's money` |
| `Send some of the treasury's money to someone. No reviewer checks it.` | `Send some of the project's money to someone. No reviewer checks it.` |
| `Couldn't read which budget is this DAO's milestone` | `Couldn't read which budget is this project's milestone` |
| `This pays straight out of the treasury. No reviewer checks anything before it goes, and nothing checks what the money is spent on. If it is for work someone will do, set aside a work budget instead: the money then leaves only for work the reviewers approve.` | `This pays straight out of the project's money. No reviewer checks anything before it goes, and nothing checks what the money is spent on. If it is for work someone will do, set aside a work budget instead: the money then leaves only for work the reviewers approve.` |

**`features/launchpad/ui/DecisionEmbed.tsx`**

| Before | After |
|---|---|
| `Reading it from the chain…` | `Reading it from the network…` |
| `That decision isn't in this project's DAO.` | `That decision isn't one of this project's.` |

**`features/launchpad/ui/DecisionVote.tsx`**

| Before | After |
|---|---|
| `Sign in with your passkey or connect a wallet to vote.` | `Sign in with your passkey or connect a wallet app to vote.` |

**`features/launchpad/ui/DecisionsTab.tsx`**

| Before | After |
|---|---|
| `This DAO has {snapshot.total} decisions. The newest` | `This project has {snapshot.total} decisions. The newest` |

**`features/launchpad/ui/DelegationCard.tsx`**

| Before | After |
|---|---|
| `...(holder ? [{ value: holder, label: "Back to myself (reclaim)" }] : [])` | `...(holder ? [{ value: holder, label: "Back to me (take my votes back)" }] : [])` |
| `The sender returned an invalid hash.` | `The request was sent but no confirmation ID came back. Check your votes above, then try again.` |
| `Delegation landed (tx ${txHash.slice(0, 10)}…) but it could not be saved to this project's record. It still counts.` | `Your votes were handed over (confirmation ${txHash.slice(0, 10)}…), but we could not save that to the project's record. They still count.` |
| `setError(senderErrorMessage(err, "The delegation was not sent."))` | `setError( senderErrorMessage(err, "Your votes were not handed over. Try again."), )` |
| `<h2>Vote delegation</h2>` | `<h2>Hand over your votes</h2>` |
| `Delegation opens once this project has a DAO.` | `You can hand over your votes once this project is set up for voting.` |
| `Delegate to` | `Hand votes to` |
| `Delegate votes` | `Hand over votes` |

**`features/launchpad/ui/FundingDecisionForm.tsx`**

| Before | After |
|---|---|
| `Stop sales while the treasury holds other tokens` | `Stop sales if the project holds other tokens` |
| `Sell even while the treasury holds a token` | `Sell even if the project holds a token` |
| `Non-voting shares get the same part of the treasury and payouts as a Share, but no vote, so the people doing the work keep the say. This cannot change later.` | `Non-voting shares get the same part of the project's money and payouts as a Share, but no vote, so the people doing the work keep the say. This cannot change later.` |
| `The part of what leaving pays that stays in the treasury, for those who stay: at most 5%. It is not charged during the 30 days' notice, and a later vote can lower it but never raise it.` | `The part of what leaving pays that stays with the project, for those who stay: at most 5%. It is not charged during the 30 days' notice, and a later vote can lower it but never raise it.` |
| `Bids set the price above this. Nothing sells below a share's part of the treasury, plus 2%.` | `Bids set the price above this. Nothing sells below a share's part of the project's money, plus 2%.` |
| `` `Sales stop while the treasury holds ETH or any of these, so a price set in USDC never gives buyers part of them for nothing. Any holder can add one too. Already watched: ${view.watched.length === 0 ? "none" : view.watched.join(", ")}.` : "Sales go ahead although the treasury holds these, and buyers get part of them without paying for it. Only for tokens worth nothing, or when holders agree to share them." `` | `` `Sales stop while the project holds ETH or any of these, so a price set in USDC never gives buyers part of them for nothing. Any holder can add one too. Already on the watch list: ${view.watched.length === 0 ? "none" : view.watched.join(", ")}.` : "Sales go ahead although the project holds these, and buyers get part of them without paying for it. Only for tokens worth nothing, or when holders agree to share them." `` |

**`features/launchpad/ui/ManagePanel.tsx`**

| Before | After |
|---|---|
| `Evidence hash must be 64 hex characters.` | `The evidence fingerprint must be 64 letters and digits (0 to 9 and a to f).` |
| `The claim is posted to the feed.` | `The submission is posted to the feed.` |
| `err instanceof Error ? err.message : "Failed to record the claim."` | `err instanceof Error ? err.message : "Couldn't record the submission. Try again."` |
| `err instanceof Error ? err.message : "Failed to record the verdict."` | `err instanceof Error ? err.message : "Couldn't record the verdict. Try again."` |
| `"Link the token address on this launch before reserving a payout." : "This launch isn't set up for onchain milestones yet. Link its milestone contracts on the launch record first."` | `"Link this project's token address first, then set the payout aside." : "This project can't hold milestone payments yet. Link its milestone contracts on its project page first."` |
| `The sender returned an invalid hash.` | `The request was sent but no confirmation ID came back. Check the record before you try again.` |
| `Onchain step sent. The hash above is filled in.` | `Sent. The confirmation ID above is filled in.` |
| `senderErrorMessage(err, "The onchain submit was not sent.")` | `senderErrorMessage(err, "Your submission was not sent. Try again.")` |
| `toast.error(err instanceof Error ? err.message : "Saving failed.")` | `toast.error( err instanceof Error ? err.message : "Couldn't save your changes. Try again.", )` |
| `If the sale reaches its goal, the money moves to your treasury, part of the supply is set aside so people can trade it, and any tokens that did not sell are returned. If it falls short, every bid is refunded.` | `If the sale reaches its goal, the money goes to the project, part of the supply is set aside so people can trade it, and any tokens that did not sell are returned. If it falls short, every bid is refunded.` |
| `supply is released only to the trading pool the treasury records. If the pool never appears, the treasury can take it back. Each step is a public transaction anyone can look up, and that is what` | `supply is released only to the trading pool the project has on record. If the pool never appears, the project can take it back. Each step is a public record anyone can look up, and that is what` |
| `Milestone attestation` | `Milestone verdicts` |
| `for people who settle milestone claims` | `for people who settle milestone submissions` |
| `<h2>Milestone attestation</h2>` | `<h2>Milestone verdicts</h2>` |
| `Reviewers settle a milestone claim on the network. Here you post that claim and your verdict to the project's feed, so people can see it, together with the transaction that settled it. A post without that transaction won't go through. If the post and the transaction ever disagree, the transaction is what counts.` | `Reviewers settle a milestone submission on the network. Here you post that submission and your verdict to the project's feed, with the confirmation ID of the step that settled it, so people can check it. A post without that ID won't go through. If the post and the network ever disagree, the network is right.` |
| `Claim id` | `Submission ID` |
| `Evidence hash` | `Evidence fingerprint` |
| `64 hex chars of the canonical claim` | `64 letters and digits, with no 0x` |
| `Settlement tx hash` | `Settlement confirmation ID` |
| `0x + 64 hex chars of the onchain tx` | `0x followed by 64 letters and digits` |
| `Record claim` | `Record submission` |
| `Submit claim onchain` | `Send submission` |
| `Attest approve` | `Send approval` |
| `Attest reject` | `Send rejection` |
| `After the claim is submitted, the treasury reserves its payout. Once enough verifiers attest, anyone can settle it, and the` | `After the submission is sent, the project sets its payout aside. Once enough reviewers approve it, anyone can settle it, and the` |
| `Reserve payout` | `Set payout aside` |

**`features/launchpad/ui/OrgDiagnosticCard.tsx`**

| Before | After |
|---|---|
| `<h3>Org diagnostic</h3>` | `<h3>Team health check</h3>` |
| `reading the event graph…` | `Reading the team's activity…` |
| `` `${report.events} events · every figure can be recomputed from the raw events` : "no window loaded"} `` | `` `${report.events} events counted · every figure can be recomputed from the saved activity` : "No activity loaded yet"} `` |
| `<section aria-label="Time signal">` | `<section aria-label="Activity rhythm">` |
| `<p> burstiness {pct(report.timeSignal.burstinessBp)} · handoffs {pct(report.timeSignal.handoffRateBp)} · median lag {report.timeSignal.handoffMedianLagS}s · {report.timeSignal.events} events </p>` | `` <Figure label="Work in rushes" meaning="How uneven the activity is. Higher means short rushes with quiet gaps between." value={pct(report.timeSignal.burstinessBp)} /> <Figure label="Work passed between people" meaning="Share of actions that came within a minute of a different person's action." value={pct(report.timeSignal.handoffRateBp)} /> <Figure label="Typical wait for the next person" meaning="When work was passed on, how long the next person took to act." value={`${report.timeSignal.handoffMedianLagS} seconds`} /> `` |
| `{report.timeSignal.reading}` | `Based on {report.timeSignal.events} events. {readingCopy(report.timeSignal.reading)}` |
| `insufficient data (<20 events), omitted, never zeroed` | `Not enough activity yet (fewer than 20 events), so nothing is shown instead of a zero.` |
| `["communicate", report.tomasello.communicate], ["build trust", report.tomasello.buildTrust], ["institutionalize", report.tomasello.institutionalize]` | `["Talking", "Messages", report.tomasello.communicate], [ "Building trust", "Contributions, access given or taken away", report.tomasello.buildTrust, ], [ "Deciding", "Proposals, votes and approvals", report.tomasello.institutionalize, ]` |
| `<section aria-label="Churn vs progress"> <h4>Churn vs progress</h4> <p> {report.thrash.revisions} revisions / {report.thrash.coordinates} coordinates · rework {pct(report.thrash.reworkRateBp)} · settled {pct(report.thrash.settledRateBp)} </p>` | `` <section aria-label="Rework and progress"> <h4>Rework and progress</h4> <Figure label="Edits" meaning="How many times items were changed, and how many different items that covers." value={`${report.thrash.revisions} edits across ${report.thrash.coordinates} items`} /> <Figure label="Edits that redo earlier work" meaning="Share of edits that changed an item already edited before." value={pct(report.thrash.reworkRateBp)} /> <Figure label="Items edited only once" meaning="Share of items written once and then left alone." value={pct(report.thrash.settledRateBp)} /> `` |
| `<section aria-label="Drift probes"> <h4>Drift probes</h4>` | `<section aria-label="Changes in behaviour"> <h4>Changes in behaviour</h4>` |
| `no actor had ≥8 events in both halves of the window` | `Nobody had at least 8 events in both halves of the period.` |
| `.join(" · ") \|\| "no flagged drift, distributions held"} {" (movement only; “bad” is never inferred here)"}` | `.join(" · ") \|\| "No one changed their behaviour much."} {" (this shows change only, never whether it is good or bad)"}` |
| `<p> {report.supervision.approvalRequests} approval requests / {report.supervision.actions} actions · saturation {pct(report.supervision.saturationBp)} · top approver {pct(report.supervision.topApproverShareBp)} ·` | `` <Figure label="Approval requests" meaning="How many of the actions needed someone's approval." value={`${report.supervision.approvalRequests} of ${report.supervision.actions} actions`} /> <Figure label="Share of actions waiting on approval" meaning="The higher this is, the more reviewers are asked to look at." value={pct(report.supervision.saturationBp)} /> <Figure label="Share of approvals from one reviewer" meaning="How much of the approving falls on the busiest reviewer." value={pct(report.supervision.topApproverShareBp)} /> <p> `` |

**`features/launchpad/ui/PowersCard.tsx`**

| Before | After |
|---|---|
| `No decision of any kind can be opened before the buyers can claim their tokens.` | `No decision of any kind can be opened before the buyers can collect their tokens.` |
| `No vote can switch off leaving with your share of what the DAO holds, or take your Shares from you.` | `No vote can switch off leaving with your share of what the project holds, or take your Shares from you.` |
| `This DAO was made with leaving switched off, and no vote can switch it on: members cannot take a share of the treasury out.` | `This project was made with leaving switched off, and no vote can switch it on: members cannot take out a share of the project's money.` |
| `Switch leaving off, or burn a holder's Shares: this DAO was made before those powers were removed.` | `Switch leaving off, or destroy a holder's Shares: this project was made before those powers were removed.` |
| `Shares cannot be sent between wallets, so nobody can sell them, until a vote opens trading; that vote can only run 30 days after trading is announced, and you can leave in between.` | `Shares cannot be sent between accounts, so nobody can sell them, until a vote opens trading; that vote can only run 30 days after trading is announced, and you can leave in between.` |
| `"Until then they cannot be sold, moved, or taken out by leaving the DAO.", "Who judges the milestones is named at launch, with how many must agree. A vote cannot swap in a different panel."` | `"Until then they cannot be sold, moved, or taken out by leaving the project.", "Who judges the milestones is named at launch, with how many must agree. A vote cannot swap in different reviewers."` |
| `Until then they cannot be sold, moved, or taken out by leaving the DAO.` | `Until then they cannot be sold, moved, or taken out by leaving the project.` |
| `The team's Shares are not locked. The team can sell or move them from the start, and they count when the DAO votes.` | `The team's Shares are not locked. The team can sell or move them from the start, and they count when the project votes.` |
| `Spend the money the DAO holds.` | `Spend the project's money.` |
| `Give up a team member's unearned Shares. They are burned, never released for sale.` | `Take back a team member's unearned Shares. They are destroyed and never put up for sale.` |
| ` The team posts a bond of ${challenge.bond} with each milestone; it is forfeited if holders turn the milestone down.` | ` The team posts a bond of ${challenge.bond} with each milestone; the team loses it if holders turn the milestone down.` |
| `treasury while one waits.` | `project's money while one waits.` |
| `The milestone panel has {panel.reviewers} reviewer {panel.reviewers === 1 ? "" : "s"}, and {panel.quorum} must agree on each milestone.` | `The milestone reviewers are a group of {panel.reviewers}, and {panel.quorum} must agree on each milestone.` |
| `Every decision waits before it takes effect. How long, under this DAO's settings today, could not be read just now; a vote can shorten those settings for decisions opened later.` | `Every decision waits before it takes effect. How long, under this project's settings today, could not be read just now; a vote can shorten those settings for decisions opened later.` |
| `Whether you can leave with your share before a decision takes effect is shown once this DAO's rules can be read.` | `Whether you can leave with your share before a decision takes effect is shown once this project's rules can be read.` |
| `` `Until it takes effect, you can leave with your share of what the DAO holds${permanent ? "; no vote can switch that off" : ", for as long as leaving stays on"}. Money already moved into a work budget is not part of that share.` : "Members cannot leave this DAO with a share of what it holds."} `` | `` `Until it takes effect, you can leave with your share of what the project holds${permanent ? "; no vote can switch that off" : ", for as long as leaving stays on"}. Money already moved into a work budget is not part of that share.` : "Members cannot leave this project with a share of what it holds."} `` |
| `possible, and if holders uphold it the team's remaining locked Shares are burned. Milestones are published in order, and the next only once the one before has had its time for late objections, so the Shares still ahead stay locked while an earlier milestone can be objected to; what stands behind the last milestone is the bond.` | `possible, and if holders agree with it, the team's remaining locked Shares are destroyed. Milestones are published in order, and the next only once the one before has had its time for late objections, so the Shares still ahead stay locked while an earlier milestone can be objected to; what stands behind the last milestone is the bond.` |
| `runs out, no milestone can be approved and the locked Shares stay locked; the only thing the DAO can then do with them is give them up and burn them.` | `closes, no milestone can be approved and the locked Shares stay locked; the only thing the project can then do with them is give them up and destroy them.` |

**`features/launchpad/ui/ProposalExtras.tsx`**

| Before | After |
|---|---|
| `About a DAO decision` | `About a project decision` |
| `Checking which DAO this is about…` | `Checking which project this is about…` |
| `This post says it is about a DAO decision, but this app doesn't know that DAO, so nothing here has been checked.` | `This post says it is about a project decision, but this app doesn't know that project, so nothing here has been checked.` |
| `Couldn't read the decision from the chain just now.` | `Couldn't read the decision from the network just now.` |
| `That decision isn't in {launchTitle(launch)}'s DAO. It may be on the newest page not shown here, or the post may be mistaken.` | `That decision isn't in {launchTitle(launch)}'s decisions. It may be on a newer page than the one shown, or the post may be mistaken.` |
| `Votes on this board show what people think. They are not the DAO's vote, which happens on the decision itself.` | `Votes on this board show what people think. They are not the project's vote, which happens on the decision itself.` |

**`features/launchpad/ui/RecordTab.tsx`**

| Before | After |
|---|---|
| `Couldn't read this DAO from the network. Try again in a moment.` | `Couldn't read this project from the network. Try again in a moment.` |
| `What this DAO has done with its money, and how much of its team's tokens have unlocked. It is read straight from the network, not typed in, so anyone can check it and it cannot be edited` | `What this project has done with its money, and how much of its team's tokens have unlocked. It is read straight from the network, not typed in, so anyone can check it and it cannot be edited` |
| `The DAO has not set any aside yet` | `The project has not set any aside yet` |
| `, ${shares(promised.givenUp)} given up by the DAO` | `, ${shares(promised.givenUp)} given up by the project` |
| `Given up by the DAO` | `Given up by the project` |

**`features/launchpad/ui/RemixBondPanel.tsx`**

| Before | After |
|---|---|
| `This project posted a bond of ${formatUnits(bond.amount, 18)} CREATE for ${parent.record.name}, held until ${date(bond.releasesAt)}.` | `This project put down a bond of ${formatUnits(bond.amount, 18)} CREATE for ${parent.record.name}, held until ${date(bond.releasesAt)}.` |
| `No bond yet. Only the project's founder can post one.` | `No bond yet. Only the project's founder can put one down.` |
| `No bond yet. The project's founder can post one from their` | `No bond yet. The project's founder can put one down from their` |
| `Post a bond in CREATE for {parent.record.name}: if the court finds this project broke its terms, the bond is theirs.` | `Put down a bond in CREATE (the court's deposit token) for {parent.record.name}: if the court finds this project broke its terms, the bond is theirs.` |
| `Post the bond` | `Put down the bond` |

**`features/launchpad/ui/TrustGateCard.tsx`**

| Before | After |
|---|---|
| `setError(senderErrorMessage(err, "The gate was not rotated."))` | `setError(senderErrorMessage(err, "The gate was not updated. Try again."))` |
| `<h3>Trust gate (TrustGraph)</h3>` | `<h3>Trust gate</h3>` |
| `` `bucket ${hook.bucket} · ${shortHex(hook.address)}` : "no hook wired on this launch (pre-launch)"} `` | `` `bid group ${hook.bucket} · ${shortHex(hook.address)}` : "No trust gate is set up for this project yet"} `` |
| (nothing) | `<p> A trust gate lets only people with a high enough score place bids. Each bid group has its own gate. </p>` |
| `<h4>Gate on-chain</h4>` | `<h4>Gate on the network</h4>` |
| `scoreRoot {shortHex(gate.data.root)} · minScore {gate.data.minScore?.toString() ?? "unreadable"}` | `Score list {shortHex(gate.data.root)} · minimum score {gate.data.minScore?.toString() ?? "could not be read"}` |
| `unreadable: the chain did not answer (not the same as empty)` | `Could not be read: the network did not answer. That is not the same as empty.` |
| `aria-label="Gated bucket"` | `aria-label="Gated bid group"` |
| `bucket {h.bucket}` | `bid group {h.bucket}` |
| `<section aria-label="Published roots"> <h4>Published score roots</h4>` | `<section aria-label="Published score lists"> <h4>Published score lists</h4>` |
| `aria-label="Score root record"` | `aria-label="Published score list"` |
| `<option value="">Choose an epoch…</option>` | `<option value="">Choose a period…</option>` |
| `${r.program} · epoch ${r.epoch}${r.standing === "publisher-claim" ? " (publisher's own claim)" : ""}` | `${r.program} · period ${r.epoch}${r.standing === "publisher-claim" ? " (publisher's own claim)" : ""}` |
| `root {shortHex(selected.root)}` | `score list {shortHex(selected.root)}` |
| ` · the record asserts block ${selected.anchorBlock} (unverified: not checked against the chain)` | ` · the record says it was made at block ${selected.anchorBlock} (not checked against the network)` |
| ` · the gate on-chain matches this root` | ` · the gate on the network matches this list` |
| ` · CONTRADICTED: the chain holds a different root` | ` · CONTRADICTED: the network holds a different list` |
| `no score-root records yet (the scoring operator publishes one per epoch)` | `No score lists published yet. The scoring operator publishes one each period.` |
| `<section aria-label="Trust graph"> <h4>The graph</h4>` | `<section aria-label="Check the scores"> <h4>Check the scores</h4>` |
| `choose an epoch, then load its proofs to check them against the root` | `Choose a period, then load its proofs to check them against the published list.` |
| `this record carries no proofs pointer, or its address is not one this app may load. Only the root ships; the workspace data stays private` | `This record has no link to its proofs, or the link is one this app will not load. Only the list's fingerprint is shared. The underlying data stays private.` |
| `Load the proofs for this epoch` | `Load the proofs for this period` |
| `fetching the proofs bundle…` | `Loading the proofs…` |
| `unreadable bundle: the indexer did not answer or the entries were malformed (dropped, never guessed)` | `The proofs could not be read: their host did not answer, or some entries were damaged and left out rather than guessed.` |
| `against the root` | `against the published list` |
| ` · CONTRADICTED: the rebuilt root differs from the published one` | ` · CONTRADICTED: the list rebuilt from these proofs differs from the published one` |
| ` · rebuilt root matches the published root` | ` · the list rebuilt from these proofs matches the published one` |
| `<section aria-label="Rotate gate"> <h4>Rotate gate</h4>` | `<section aria-label="Update the gate"> <h4>Update the gate</h4>` |
| `` One call, owner-only: `setScoreRoot(root, minScore)` to the selected epoch's root. `` | `Owner only. Points the gate at the chosen period's score list and sets the minimum score.` |
| `aria-label="minScore"` | `aria-label="Minimum score"` |
| `minScore` | `Minimum score` |
| `Rotate to epoch {selected?.epoch ?? "…"}` | `Update to period {selected?.epoch ?? "…"}` |
| `rotated · {shortHex(lastTx)}` | `Updated · confirmation {shortHex(lastTx)}` |

**`features/launchpad/ui/TrustGraphCuratorPanel.tsx`**

Also: 1 wording tweak(s) of spelling, punctuation or capitalization only.

| Before | After |
|---|---|
| `Score root composed for epoch ${built.epoch}: ${Object.keys(built.proofs).length} member${Object.keys(built.proofs).length === 1 ? "" : "s"}, every proof verified.` | `Score list composed for period ${built.epoch}: ${Object.keys(built.proofs).length} member${Object.keys(built.proofs).length === 1 ? "" : "s"}, every proof verified.` |
| `Score root published for epoch ${bundle.epoch}.` | `Score list published for period ${bundle.epoch}.` |
| `Gate rotated to ${gateRoot.trim().slice(0, 10)}… (transaction ${result.txHash}).` | `Gate updated to ${gateRoot.trim().slice(0, 10)}… (confirmation ${result.txHash}).` |
| `${senderErrorMessage(err, "The gate was not rotated.")} You can send the rotation again. Check the gate address first.` | `${senderErrorMessage(err, "The gate was not updated.")} You can send the update again. Check the gate address first.` |
| `Compose this community's score root from a scores set, publish it for an epoch, and rotate the onchain gate to the new root. Publishing writes a signed record; the gate rotation is an onchain action the gate owner confirms before it sends. Each step shows its result here.` | `Build this community's score list from a set of scores, publish it for a period, and point the gate on the network at the new list. Publishing saves a signed record. Updating the gate is a network step the gate owner confirms before it is sent. Each step shows its result here.` |
| `private. Only the proof-backed root is published.` | `private. Only a proof-backed fingerprint of the list is published.` |
| `Compose score root` | `Build score list` |
| `root: {bundle.root}` | `List fingerprint: {bundle.root}` |
| `published as the score-root record (event 37006), replaceable per epoch.` | `published as the score list record, replaceable for each period.` |
| `Publish this score root for epoch {bundle.epoch}?` | `Publish this score list for period {bundle.epoch}?` |
| `Publish score root` | `Publish score list` |
| `<h3>Gate rotation</h3>` | `<h3>Update the gate</h3>` |
| `Rotating points the onchain gate at a new score root and minimum score. The gate owner's wallet sends this, and you confirm before` | `This points the gate on the network at a new score list and minimum score. The gate owner's account sends it, and you confirm before` |
| `Gate root` | `Gate list fingerprint` |
| `0x + 64 hex (filled in when you compose)` | `Filled in when you build the score list` |
| `Rotate the gate to {gateRoot.trim().slice(0, 10)}… at minimum` | `Update the gate to {gateRoot.trim().slice(0, 10)}… at minimum` |
| `Confirm rotation` | `Confirm update` |
| `Rotate gate` | `Update gate` |
| `Epoch` | `Period` |

**`features/launchpad/ui/VoteControlNote.tsx`**

| Before | After |
|---|---|
| `The team's Shares vote from the first day; backers' Shares vote only once they are claimed from the sale, so until enough are claimed the team holds most of the votes that count and can pass decisions alone. Once every sale Share is claimed, the team holds ${rounded}% of the votes: ${power}.` | `The team's Shares vote from the first day; backers' Shares vote only once they are collected from the sale, so until enough are collected the team holds most of the votes that count and can pass decisions alone. Once every sale Share is collected, the team holds ${rounded}% of the votes: ${power}.` |

**`features/launchpad/ui/decision-forms.tsx`**

| Before | After |
|---|---|
| `"This changes what the DAO can do or spend, so it takes the full vote." : "This is inside a budget the DAO already voted, so it takes the lighter vote."}` | `"This changes what the project can do or spend, so it needs the full vote." : "This is inside a budget the project already voted on, so it needs the lighter vote."}` |
| `work for review; the words below are what all of it is judged against, exactly.` | `work for review. All of it is judged against the exact words you write below.` |
| `The milestone panel (judges your team's milestones)` | `Milestone reviewers (judge your team's milestones)` |
| `That is more new Shares than this year allows: ${formatUnits(allowanceLeft, 18)} are left to award.` | `That is more than this year's limit on new Shares. ${formatUnits(allowanceLeft, 18)} can still be awarded this year.` |
| `This year's allowance of new Shares has ${formatUnits(allowanceLeft, 18)} left.` | `This year's limit on new Shares has ${formatUnits(allowanceLeft, 18)} left.` |
| `The treasury holds only ${formatUnits(balance.data, decimals, 4)} ${ctx.currencySymbol}.` | `The project's money holds only ${formatUnits(balance.data, decimals, 4)} ${ctx.currencySymbol}.` |
| `Pay someone from the treasury. Nothing moves until holders back it and it takes effect.` | `Pay someone from the project's money. Nothing moves until holders back it and it takes effect.` |
| `Network: chain {ctx.chainId ?? "unknown"}. Token: {ctx.currencySymbol}` | `Network ID: {ctx.chainId ?? "unknown"}. Token: {ctx.currencySymbol}` |
| `` "Reading the treasury…" : `The treasury holds ${formatUnits(balance.data, decimals, 4)} ${ctx.currencySymbol}.`} `` | `` "Reading the project's balance…" : `The project's money holds ${formatUnits(balance.data, decimals, 4)} ${ctx.currencySymbol}.`} `` |
| `Who to pay (wallet address)` | `Who to pay (account address)` |

**`features/launchpad/ui/widgets.tsx`**

| Before | After |
|---|---|
| `Live chain values.` | `Live values from the network.` |
| `No chain data: ${data.reason ?? "unavailable"}.` | `No network data: ${data.reason ?? "unavailable"}.` |
| `No chain data` | `No network data` |

**`features/launchpad/use-court.ts`**

| Before | After |
|---|---|
| `Connect your wallet first.` | `Connect a wallet app first.` |

**`features/launchpad/ui/DecisionDiscussion.tsx`**

| Before | After |
|---|---|
| `people think; they are not the DAO's vote.` | `people think; they are not the project's vote.` |

## 3. Needs a human or counsel

Two kinds of entry. A to L were flagged while the pass ran: legally loaded lines it left alone, with a plainer version proposed. M to R were found while preparing this document: lines the pass did change that sit in legally loaded or factual territory, so a person should confirm the new wording says the same thing. Nothing here has been applied. Quoted text is the current text in the code unless it says otherwise.

### A. What opening transfers means
- Where: `features/start/ui/ContributorStartPage.tsx`, the 'what it is' list, and `features/start/lib/contributor-project.ts` (the share-cap line).
- Current: 'Shares can't be sold at first. Opening transfers takes two project votes, at least 30 days apart.' And: 'Start with at most a third of the Shares the first budget can award, so the people who do the work can end up holding most of the project.'
- Proposed: 'Opening transfers means letting holders send Shares to others. It takes two project votes, at least 30 days apart.' The share-cap line stays as it is.
- Why: sale and Share wording is legally loaded, so it was left. 'Opening transfers' is not explained to a new reader.

### B. Stake and Share-count lines on Start
- Where: `features/start/ui/ContributorStartPage.tsx`, the 'From the Projects board' card, and the preview text.
- Current: 'Each role is a first work area that can award up to its stake.' and '1,000,000 Shares stand for the whole project once every role's work is awarded.'
- Proposed: 'Each role is a first work area that can award up to the Shares set aside for it. 1,000,000 Shares make up the whole project once every role's work is awarded.'
- Why: ownership and sale wording, so not edited. 'Stake' may confuse a new reader.

### C. 'The empty address'
- Where: `features/start/lib/contributor-project.ts`, near line 444.
- Current: 'A reviewer cannot be the empty address.'
- Proposed: 'A reviewer needs a real account address, not an all-zero one.'
- Why: 'empty address' is jargon, but it was not confirmed from the code that it means the all-zero address, so it was kept. Someone who knows the rule should confirm before the proposal is used.

### D. The pledge disclaimer and the pool line
- Where: `features/projects/ui/JoinDialog.tsx` (`STAKE_DISCLAIMER`), also shown in the pool strip of `features/projects/ui/ProjectDetailPage.tsx`.
- Current: 'A record on this board that the founder can take back: not Shares, not a payment, and not a legal contract. Shares come only from awards for accepted work.' Beside it: 'of the {POOL_PCT}% pool still unrecorded' (and 'of the pool still unrecorded' in the join dialog).
- Proposed: no change to the disclaimer. Consider 'of the 100% of stakes still unrecorded' for the pool line.
- Why: the disclaimer is plain already and is legal wording. 'Pool still unrecorded' may confuse a newcomer.

### E. Board description when raises are offered
- Where: `features/projects/ui/BoardPage.tsx` (only in builds that offer raises).
- Current: 'Founders pitch projects here. Pick a role and ask to join; if the founder agrees, your share is recorded. It is not a legal contract, and it can be undone until the project's DAO takes it on.'
- Proposed: the same, ending 'until the project's holders take it on.'
- Why: a legal line with a DAO reference, left unedited per the rules.

### F. The two header chips on a project
- Where: `features/launchpad/lib/contributor-status.ts`.
- Current: 'One vote can make Shares sellable' and 'A vote can create Shares'.
- Proposed: no change. Counsel to confirm they are plain enough.
- Why: sale and trading disclosures that read well but use 'vote' and 'sellable'.

### G. Sale terms on the Overview card (builds that offer raises)
- Where: `features/launchpad/ui/OverviewTab.tsx`, the tokenomics card.
- Current: 'Valuation at the floor' and 'Your bid fills over time at the auction's current clearing price, up to your price limit. Different parts of the sale can clear at different prices.'
- Proposed: counsel to review. A plainer line could be: 'The price you pay can end up higher than the floor price, but never above your price limit.'
- Why: sale terms, left as legally loaded.

### H. IP and entity lines
- Where: `features/launchpad/lib/ip-record.ts`, headlines and details.
- Current: 'The project hasn't said who holds its IP'; 'There is no entity, and no commitment to assign the IP to one is on record. Holders have no claim on it, and the founders carry the legal risk personally.'
- Proposed: keep, or add after IP in the first headline: '(the rights to its code, name and designs)'. Counsel to confirm.
- Why: legally loaded IP and assignment lines. The pass only added a one-line meaning of IP and of a fingerprint in the card and the editor (new text: 'IP means the rights to the project's work, such as its code, name and designs.' and 'A fingerprint is a short code made from a file. If the file changes, the code changes, so anyone can tell.').

### I. The objection rule
- Where: `features/launchpad/ui/LaunchReviewFields.tsx` (also the same rule in `ChallengeMilestones.tsx`, `PowersCard.tsx` and `challenge-attention.ts`).
- Current: 'A holder who objects starts a vote of holders; your team's own Shares do not count. The objection stands only if more is against the milestone than for it and at least X% of what could vote is against it. Otherwise, including when nobody votes, the milestone stands.'
- Proposed: 'A holder's objection succeeds only if more holders vote against the milestone than for it, and the votes against are at least X% of all votes that could be cast. If nobody votes, the milestone goes ahead.'
- Why: a rule disclosure that is hard to read, so it was not changed.

### J. Locked Shares and leaving
- Where: `features/launchpad/ui/create-wizard/WizardSteps.tsx` (the 'own DAO' hint and the unlock note); the same phrase appears in `LockedSharesCard.tsx` ('or given up when you leave') and `ChallengeLockedCard.tsx`.
- Current: 'Your team's Shares are yours to vote with from the start. A milestone decides when part of them can be sold, or used to leave with a share of the project's money.'
- Before the pass it read 'taken out of the DAO'.
- Proposed: accept, or use 'used to withdraw your share of the project's money'.
- Why: same meaning, but it is a leave-and-exit disclosure, so a person should confirm the new phrase keeps its force.

### K. What a buyer gets in each outcome
- Where: `features/launchpad/lib/amounts.ts`, `SETTLEMENT_TERMS` (three lines).
- Current: 'If the threshold is met: The sale clears at one uniform price, everyone pays that price for their fill, liquidity is seeded from the clearing price and the rest of the raise goes to the treasury. Tokens are claimable after the claim block.' 'If the threshold is missed: No sale happens and every bid is refundable in full; no entity is formed and no tokens are issued. Nothing is lost but the transaction fees.' 'Before either: Bids are committed on chain and cannot be withdrawn early. Your budget is your maximum: you pay the clearing price for whatever fill you get, not your maximum price.'
- Proposed: 'If the minimum is met: every buyer pays the same final price for what they get, part of the raise is set aside to start a market for the token at that price, and the rest goes to the project. If it is missed: no sale happens, every bid is refunded in full, and nothing is lost but the network fees. Before either: bids are recorded on the network and cannot be withdrawn early.' (The sentence about the budget being the maximum would need to be kept.)
- Why: a legally loaded sale disclosure with technical words (clearing price, liquidity is seeded, on chain, transaction fees). The guide says record it, do not edit it.

### L. Revenue pledge, empty state
- Where: `features/launchpad/ui/RevenuePledgeCard.tsx`, the sentence shown when no pledge exists. The flag for this one was cut short when it reached this document, so the entry is completed from the code.
- Current: 'You have not pledged to pay in any of what the project earns. A pledge is how revenue reaches holders here: money paid in raises every Share's part of the project's money.' (The pass changed it from '...pledged any of what the project earns to the treasury...'.) The card also says below: 'Nothing is paid to holders automatically. What is paid in stays in the project's money, where every holder can leave with their part of it.'
- Proposed: for counsel to decide. 'How revenue reaches holders' and 'raises every Share's part' read as a route to returns; consider 'A pledge is a promise to pay part of what the project earns into its money. It does not pay holders directly.'
- Why: sale and Share wording near a return. The original already had it; the pass kept the meaning.

### M. 'The contracts check none of this' became 'Nothing in the app's code enforces this list'
- Where: `features/launchpad/ui/TradingForm.tsx`, the note under the checklist that must be ticked before trading opens.
- Before: 'The contracts check none of this. A vote can announce trading without it; what protects holders is the 30 days, in which anyone can leave with their share of the treasury.'
- Now: 'Nothing in the app's code enforces this list. A vote can announce trading without it; what protects holders is the 30 days, in which anyone can leave with their share of the project's money.'
- Why: this may have shifted the claim. The original said the project's contracts do not check the list; the new text says the app does not enforce it. Those are different statements. Suggested: 'The project's rules do not check this list.' A person who knows what the app itself checks should confirm.

### N. Bond meaning ('a deposit you lose if you act carelessly')
- Where: `features/launchpad/ui/WorkTab.tsx` ('a deposit you lose if you approve carelessly'), `features/launchpad/lib/dao-overview.ts` ('A bond is a deposit you lose if you act carelessly.') and `features/launchpad/ui/enforcement-forms.tsx` ('A bond is the deposit a reviewer put down.').
- Why: the pass added a plain meaning of bond. 'Carelessly' is a judgment word, while the enforcement form says a bond is taken after an approval someone disputes. Confirm the plain meaning matches when a bond can actually be taken, and that it is not read as a promise either way.

### O. A frozen submission that was undone
- Where: `features/launchpad/lib/record.ts`.
- Before: 'Unwound by the DAO after it was frozen.'
- Now: 'Frozen, then undone by the project. The contributor got their deposit back and the set-aside payment returned to the project.'
- Why: the new text states what happened to the money, which the old line did not. The commit message says only that the line now says what happened to the money; a person should confirm the new line is true in every case that status covers.

### P. How funding works (weekly sales terms)
- Where: `features/launchpad/ui/FundingCard.tsx`, the 'How funding works' text.
- Why: the pass reworded the whole paragraph (non-voting shares, the exit fee of at most 5%, the 30 days, the 2% above a share's part of the project's money, the watch list, settling). The numbers are unchanged. Counsel should re-read it end to end. One clumsy phrase to fix: 'the exit fee part of what leaving pays stays in the project's money' (suggested: 'the part of the payout taken as the exit fee stays in the project's money').

### Q. 'Void' round became 'not settled in time'
- Where: `features/launchpad/lib/trading-copy.ts` and `features/launchpad/ui/TradingCard.tsx`.
- Before: 'If nobody settles within two days the round is void and everyone takes back what they put in.'
- Now: 'If nobody settles within two days, nothing trades and everyone takes back what they put in.' and 'The round was not settled in time, so your money comes back to you.'
- Why: same outcome in plainer words. Trading disclosures, so counsel should confirm the risk lines ('You may get back less than you paid', and the others the guide lists) are still all present and unweakened. The pass did not edit those.

### R. Checks that ran 'in a protected space'
- Where: `features/launchpad/ui/ChecksRunSection.tsx`.
- Before: 'The publisher reports the checks were confined (sandbox: enforced). That is their report, not a remote check — the page cannot attest the container. It does not say the work is good: only your verdict does.'
- Now: 'The publisher says the checks ran in a protected space. That is their report, and this page cannot confirm it. It does not say the work is good: only your verdict does.'
- Why: a technical claim moved to a plain one. Confirm 'protected space' is a fair reading of 'sandbox enforced'.

## 4. How to send notes

Quote the screen text exactly as you see it, or give the file path from section 2 (for example `features/launchpad/ui/TradingForm.tsx`), and say what to change. Three shapes work well:

- Change this line: 'old text' to 'new text'. Say which screen it was on.
- Do not touch this line, a lawyer has to approve it: 'text'. It will be added to section 3.
- This word is still unclear: 'word', on this screen. Say what you thought it meant.

Lines in section 3 get a plain yes or no ('A: use the proposal', 'K: counsel will rewrite'). Anything touching a number, a price, a risk line or a sale term is held for counsel before it changes. A word that appears in many places (for example 'Shares' or 'bond') is better raised once as a rule than line by line. Notes go in the chat with the page and the sentence; the pass will quote the old and new text back before it commits.
