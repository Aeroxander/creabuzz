# Terms of use and privacy note (drafts)

`TERMS-DRAFT.md` and `PRIVACY-DRAFT.md` are plain-language drafts for the operator and a lawyer. They are not legal
advice. Before a public launch:

1. Fill in every `[bracket]`: operator name, address, contact email, minimum age, how long logs are kept, which outside
   providers are used, governing law.
2. Check them against how the server is really hosted and configured (logs, backups, error reports, onramp, chain node).
3. Have a lawyer review them for the countries your users are in.

The server shows them at sign-up when they are set as environment values (the whole Markdown text, not a path):

```bash
export BUZZ_TERMS_OF_SERVICE_MARKDOWN="$(cat docs/policies/TERMS-DRAFT.md)"
export BUZZ_PRIVACY_POLICY_MARKDOWN="$(cat docs/policies/PRIVACY-DRAFT.md)"
# BUZZ_AGE_ATTESTATION_REQUIRED=true   # adds an "I am 18 or older" box
```

It then serves them at `/api/join-policy/terms` and `/api/join-policy/privacy`, and sign-up asks people to agree before
an account is made (D83). When neither is set, sign-up shows no terms at all, so set them before inviting anyone.
