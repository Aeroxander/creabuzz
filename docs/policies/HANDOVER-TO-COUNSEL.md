# What to hand to the lawyer, and what to get back

## Send these four files

1. `docs/policies/TERMS-DRAFT.md`: the terms of use, as the drafts stand now.
2. `docs/policies/PRIVACY-DRAFT.md`: the privacy note.
3. `docs/policies/LAWYER-FEEDBACK-RESPONSE.md`: what we changed after the two reviews, and what is still open. The section "Order to settle things before the pilot" is the checklist.
4. `docs/operator-takedown-and-data-requests.md`: the steps the terms promise (takedowns, appeals, put-back, requests from authorities). Counsel should confirm the authority-request steps.

For the weekly-sales questions (needed before any real money, not for the test pilot), also send `docs/v3-review/LAWYER-BRIEF-WEEKLY-SALES.md`.

## Facts only you can give the lawyer (they go into the brackets)

- Your name and legal form, and your postal address.
- Contact emails: general, takedown and abuse, appeals, data requests.
- Hosting: OVH, United States. Backups run on the same server and are encrypted to a key held off the server.
- Whether the server disks are encrypted (ask OVH, or say "not known" and delete the line).
- Whether the AI helpers are switched on (today: no, unless you set it up) and whether error reporting is on (today: no).
- Services that see data: Alchemy (chain node), ZeroDev (passkey accounts), and the AI service if it is on.
- How long logs, reports and the security record are kept, and how often backups run and for how long they are kept.
- The mobile app is not offered in the pilot (so the mobile bracket can be deleted).

## What the lawyer decides (they go into the brackets)

Who the data controller is, and whether an EU or UK representative is needed. The legal basis for each use of data. The safeguard for sending data abroad, and each provider's role. The liability cap, governing law and courts. The copyright agent, the waiting period before put-back, the repeat-infringer rule, and the EU dispute body. Any age above 18, and the portable-copy scope.

## What to ask them to send back

Two finished files, `terms.md` and `privacy.md`:

- Plain Markdown, with headings, lists and paragraphs only. No tables (the server's pages do not show them).
- No `[bracket]` left. A bracket inside a code fence or a link is allowed, anything else makes the server refuse to start.
- A real date on the line `Last updated: …` at the top (not `[date]`).
- A sentence that promises something the software cannot do yet is deleted or reworded, not left in brackets.

## Then

Copy both to the server and run the command from the chat: it puts them in `deploy/compose/policies/`, sets `BUZZ_TERMS_FILE` and `BUZZ_PRIVACY_FILE`, records the text with `./run.sh policy-stamp`, and restarts the relay. Change the `Last updated` date whenever the text changes.
