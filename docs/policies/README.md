# Terms of use and privacy note (drafts)

`TERMS-DRAFT.md` and `PRIVACY-DRAFT.md` are plain-language drafts for the operator and a lawyer. They are not legal
advice. Before a public launch:

1. Fill in every `[bracket]`: operator name, address, contact email, the abuse and takedown email and the appeals
   contact, minimum age, how long logs are kept, which chain node providers are used, governing law.
2. Check them against how the server is really hosted and configured (logs, backups, error reports, the chain nodes,
   ZeroDev for passkey accounts).
3. Have a lawyer review them for the countries your users are in. The terms' "Work for projects" section and the
   governing law are marked for the lawyer: settle those before the contributor pilot.

The server shows them at sign-up when they are set as environment values (the whole Markdown text, not a path):

```bash
export BUZZ_TERMS_OF_SERVICE_MARKDOWN="$(cat docs/policies/TERMS-DRAFT.md)"
export BUZZ_PRIVACY_POLICY_MARKDOWN="$(cat docs/policies/PRIVACY-DRAFT.md)"
# BUZZ_AGE_ATTESTATION_REQUIRED=true   # adds an "I am 18 or older" box
```

On the compose deployment (`deploy/compose`, Creaton), name the finished files in `.env` instead
(`BUZZ_TERMS_FILE=policies/terms.md`, `BUZZ_PRIVACY_FILE=policies/privacy.md`): `run.sh` reads them and refuses to start
while a file still has a `[bracket]` left.

It then serves them at `/api/join-policy/terms` and `/api/join-policy/privacy`, and sign-up asks people to agree before
an account is made (D83). When neither is set, sign-up shows no terms at all, so set them before inviting anyone.
