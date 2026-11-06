# Terms of use and privacy note (drafts)

`TERMS-DRAFT.md` and `PRIVACY-DRAFT.md` are plain-language drafts for the operator and a lawyer. They are not legal
advice. The lawyer's first review is answered point by point in `LAWYER-FEEDBACK-RESPONSE.md`: hand that file back with
the drafts. It also lists what is still open, who owns each item, and the order to settle things in.

Two kinds of bracket are left on purpose. The guard that refuses to start while a bracket is left is in the compose
start script only (see below); a direct run of the server serves brackets as they are. Deal with both kinds before
launch:

- A fill-in or a choice: the operator fills it in (name, address, emails, periods, hosting) or counsel chooses (legal
  basis, controller, transfer safeguards, liability cap, governing law, copyright agent, EU dispute body).
- A promise the software cannot keep yet, such as telling people directly about a material change. Build the
  feature, then remove the brackets. Asking signed-in people to agree again when the served text changes is built
  (the app compares the served version with the one agreed to in the browser), so that sentence's brackets can go once
  counsel settles what counts as material. If it will not be built before launch, delete the sentence.

Before a public launch:

1. Fill in every `[bracket]` in both files. Keep each bracket on one line: the start guard reads one line at a time and
   does not see a bracket that runs over two lines.
2. Check the drafts against how the server is really hosted and configured (logs, backups, error reports, the chain
   nodes, ZeroDev for passkey accounts, whether the AI service is on).
3. Have a lawyer review them for the countries your users are in.
4. Switch on the age box. The age is 18 everywhere (terms, sign-up box, privacy note). The box only appears when
   `BUZZ_AGE_ATTESTATION_REQUIRED=true` is set (see below), and the compose files do not set it for you.
5. Change `Last updated` in both files whenever the text changes. Nothing checks this yet.

A separate real-money terms document is required before the pilot pays anyone money or any Shares can be sold. The
current terms say the service does not do either. Employment status, tax, consumer rules for sales and the
real-money age rules are left for that document. The weekly-sales legal track is in
[the weekly sales brief for counsel](../v3-review/LAWYER-BRIEF-WEEKLY-SALES.md). Keep the two tracks in step: when
one changes an answer (age, liability cap, governing law, copyright agent), change the other.

The server shows the drafts at sign-up when they are set as environment values (the whole Markdown text, not a path):

```bash
export BUZZ_TERMS_OF_SERVICE_MARKDOWN="$(cat docs/policies/TERMS-DRAFT.md)"
export BUZZ_PRIVACY_POLICY_MARKDOWN="$(cat docs/policies/PRIVACY-DRAFT.md)"
export BUZZ_AGE_ATTESTATION_REQUIRED=true   # adds the "I am 18 years of age or older" box
```

The server itself does not check for brackets when it is started this way, so a direct run serves them as they are.
Use the compose deployment for any real launch.

On the compose deployment (`deploy/compose`, Creaton), name the finished files in `.env` instead
(`BUZZ_TERMS_FILE=policies/terms.md`, `BUZZ_PRIVACY_FILE=policies/privacy.md`): `run.sh` reads them and refuses to start
while a file still has a `[bracket]` left. Add `BUZZ_AGE_ATTESTATION_REQUIRED=true` to the same `.env`.

It then serves them at `/api/join-policy/terms` and `/api/join-policy/privacy`, and sign-up asks people to agree before
an account is made (D83). When neither is set, sign-up shows no terms at all, so set them before inviting anyone. The
pages are plain Markdown without tables, so keep the drafts to headings, lists and paragraphs.
