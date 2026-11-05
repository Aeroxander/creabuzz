# Response to the lawyer's review of the terms and privacy note

For: the owner, to hand back to counsel with `TERMS-DRAFT.md` and `PRIVACY-DRAFT.md`. These are drafts, not legal advice.
Every sentence that says what the system does was checked against the code or an operator document. Where it would
promise something that does not exist, the sentence is in square brackets and listed under "Code follow-ups" below.
Where counsel must choose, there is a bracket that names the choice and the options on one line. The server refuses
to start while any bracket is left in a served file. That is the intended guard.

"Owner" means the operator who decides business and hosting facts. "Counsel" means the lawyer. "Code" means a software
change.

| # | What the lawyer said | What changed | Still open, and who owns it |
|---|---|---|---|
| 1 | Age is 16 in the terms and 18 in the sign-up box. Use one number. | Terms, Your account: 18, or higher where local law says so. Privacy note, new Age section: 18. README step 4. The sign-up box already says 18, so no app text changes. | Owner: set `BUZZ_AGE_ATTESTATION_REQUIRED=true` in the live `.env`; without it the box does not show. Code: make the compose files set it, and make the desktop and web wording share one source. Counsel: confirm 18 for the real-money terms. |
| 2 | No legal basis per use. Controller and contact must be explicit. EU representative if needed. Report retention needs a period or criteria. | Privacy note: new Who we are section; new Why we use your data section with one basis bracket per use; retention stated for logs (by size), data on the server (until removed or deleted on request); brackets for the report and security-record periods. | Counsel: choose the basis for each use, confirm the controller, decide on an EU or UK representative. Owner: legal name, address, email; periods for reports and the security record (no job deletes anything by age today). Code: optional deletion job once periods are set. |
| 3 | "Under their own privacy policies" is not a transfer safeguard. Name the providers, say processor or independent controller, state the mechanism. ZeroDev sees IPs. | Privacy note, Other services: each recipient (page node, server node, AI service, ZeroDev, error collector, hosting) has a role bracket and a transfer bracket. ZeroDev's IP exposure is stated. The old sentence is gone. Also corrected: the AI service gets the typed text from our server; our server logs who used it and bytes, not the text. | Owner: name every provider and its country. Counsel: role and transfer mechanism for each. Owner: ZeroDev retention. |
| 4 | Missing rights: portability, restriction, withdrawal of consent, Article 22. Automated checks are not mentioned. | Privacy note, Your rights: all four added, plus a copy, correction, deletion and objection; a copy and deletion are done by hand today and the text says so. New Automatic checks and decisions section. Terms, new Automatic checks and rules section: one line each for AI helpers, work check records, review and settlement, new Shares and votes, limits, ordering, scores for sales. Finding: nothing automatic decides a reward, Shares, standing or access by itself in the pilot; some contract rules run once people have voted. Score-root scoring is not live (no sale in the pilot). Human route: write to the contact email. | Counsel: whether any rule is an Article 22 decision; consent uses. Owner: promise a person and an answer time (staffing). Code: the in-app download button is in brackets; no appeal route exists for a turned-down or lapsed submission. |
| 5 | US: DMCA skeleton. EU: statement of reasons and out-of-court settlement. Build on the appeals clause. | Terms, Reports, takedowns and appeals: appeals clause kept and widened to cover limits; message sent on removal described as it is today; new Copyright claims subsection (notice contents, takedown, counter-notice, put-back, repeat-infringer). Brackets: designated agent, counter-notice wording and waiting period, repeat-infringer rule, EU dispute body. | Counsel: choose all five bracketed items. Owner: appeals contact, days to answer, abuse email. Code: moderation messages do not yet always give a reason, the rule or how to appeal; no repeat-notice count or put-back step. |
| 6 | No cap on direct liability. Consumer rights cannot be excluded. | Terms, No guarantees: saving line added (consumer rights, liability the law does not allow to be limited). Cap and carve-outs (fraud, wilful misconduct, death, personal injury) in one bracket with options. | Counsel: set the cap and carve-outs. |
| 7 | Posting in General is weak notice. Material changes and any privacy change need direct notice. Terms changes need re-acceptance at next login. | Terms and privacy Changes sections: General post kept; direct notice and re-acceptance written but in brackets because they do not exist (invite claims check the version; existing members are never asked again). | Code: direct notice mechanism; gate that asks members to agree again; make sign-up read back the accepted version. Counsel: what counts as material. |
| 8 | Work licence: non-exclusive, worldwide, perpetual, irrevocable, sublicensable to project members, for the project's purposes. | Terms, Work for projects: written as the lawyer asked, with the reason it cannot be revoked (the record sits on a public blockchain). | Counsel: confirm wording. |
| 9 | Moral rights cannot be waived everywhere (France, Germany). | Terms, Work for projects: you keep those rights where law says so and the licence applies as far as law allows. Bracket for the choice once governing law is set. | Counsel: decide after the governing law. |
| 10 | Infringing work has no removal path. Shares granted can be clawed back (if the system can). Submitter responsible. Express indemnity is counsel's call. | Terms, Work for projects: removal from this server; the blockchain record stays; holders can freeze a reward before payout; after payout the contracts as built give no way to take Shares back (so no clawback is promised); submitter responsible. Brackets: remedy for Shares already paid, and an express indemnity. | Counsel: both brackets. Owner: confirm the live pilot uses the contract kit with the no-burn rule (an older kit may differ). Code: no button hides one evidence update; the operator removes it by hand. |
| 11 | Platform terms are a floor project terms cannot remove. | Terms, new subsection How a project's terms fit with these terms: floor, project terms may add and not subtract, these terms win. A line that a project's terms bind you only if shown and agreed; the app step is bracketed. | Code: show and record a project's contributor terms when a person submits (not built). Counsel: confirm the floor wording. |
| 12 | Employment classification stays deferred until real money. Name the real-money terms as required. | Terms, Projects, money and tokens and Work for projects: not employed; the service pays no money and sells no Shares yet; separate real-money terms are required first. README: same requirement stated, linked to the sales brief. | Counsel and owner: write the real-money terms (employment, tax, consumer rules, age) before the pilot pays anyone or any Shares can be sold. |
| 13 | The privacy note never mentions minors. | Privacy note, new Age section: under 18 may not use the service; we do not knowingly keep their data; we may close an account; we keep no age answer. | Owner: the age box switch (see 1). |
| 14 | Terms bind on creating an account or posting. Keep the checkbox unconditional on every path. | Terms opening: you agree by ticking the box (passkey, wallet or key) and by posting. The web form already waits for the box on all three sign-up paths. | Code: confirm that importing a recovery key also waits for the box; do not let sign-up go on when the terms cannot be loaded; wallet sign-up is not offered in the hosted build. |
| 15 | One sentence on key security. | Privacy note, Your key and your device: the key sits in browser storage with its lock beside it (in effect unprotected), a compromised device is a compromised account; passkey or wallet and a saved recovery key recommended. Also corrected an old claim that a passkey always holds the key. | None. |
| 16 | The served Last updated date must change when the served text changes. | README step 5 states the rule. Both files keep `Last updated: [date]` as a fill-in. | Code: a companion check that fails when the served text changed and the date did not (store a hash with the date). Owner: fill the date. |
| Process | Cross-link the weekly sales brief. | README: link to `docs/v3-review/LAWYER-BRIEF-WEEKLY-SALES.md` and a note to keep the two legal tracks in step. | Owner: send both to counsel together. |

## Facts that changed the drafts

- The old privacy note said logs with IP addresses are kept for 30 days. The relay logs show the proxy's address, there is no web server access log, and logs are kept by size (five files of 10 MB per service). Rewritten.
- The old note said a passkey keeps the key. That is true only when the device supports key derivation. Rewritten.
- The security record (one row per stored item, with the sending account) was not mentioned and is now.
- Backups hold the server's settings and secrets and are not encrypted by the script. Now said.
- Reports can reach the server owner. Now said.
- The brackets guard reads one line at a time, so a bracket that ran over two lines in the old drafts (for example the abuse email and the backup location) was not caught. All brackets are now on one line.

## Code follow-ups (needs code)

1. Ask existing members to agree again to changed terms at their next sign-in, and read back the accepted version.
2. Direct notice of material changes and of any privacy-note change (message or banner).
3. A companion check that the served Last updated date changed when the served text changed.
4. Age: make the compose files set `BUZZ_AGE_ATTESTATION_REQUIRED=true`; one source for the number 18.
5. Moderation messages: make the reason required, add the rule or law relied on, say whether a tool was used, and say how to appeal.
6. Download and delete requests from the app; export that includes reports a person made.
7. Show and record a project's contributor terms when work is submitted.
8. Copyright: a repeat-notice count per account, a put-back step, and a notice to the poster when media is removed by command.
9. Confirm the recovery-key import path waits for the terms box, and that sign-up stops when the terms cannot load.
10. Deletion job by age for reports, the security record and logs, once periods are set.
11. Make the start guard catch brackets that run over two lines.
12. Confirm what an author's own delete removes from the server.

## Order to settle things before the pilot

1. Owner: fill the facts only the operator knows: name, address, emails, hosting provider and country, backup days and place, whether disks are encrypted, whether the AI service and error reporting are on, provider names, appeals contact.
2. Owner: set `BUZZ_AGE_ATTESTATION_REQUIRED=true`; confirm the contract kit version in the live pilot.
3. Counsel: controller, representative, legal bases, roles and transfer safeguards for each provider.
4. Counsel: liability cap, governing law, moral rights, infringing-work remedies, copyright agent, repeat-infringer rule, EU dispute body, Article 22 view.
5. Owner and code: decide for each bracketed promise whether it is built before launch or the sentence is deleted (items 1, 2, 5, 6 and 7 above are the main ones).
6. Owner: set periods for reports, the security record and logs; fill the dates; run the compose start to confirm no bracket is left.
7. Before anyone is paid or any Share can be sold: counsel and owner write the real-money terms and the sales terms from the weekly sales brief.
