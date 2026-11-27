# Creaton's earlier backers: the claim journey in the app, counted. Plain Python, standard library.
# Run: python3 -I docs/archive/econ/earlier_backer_journey.py
# App and server lane, 18 November 2026. Every count is SIMULATED (this model of screens not yet built); the reading,
# pressing and typing speeds are the app's own (app/tests/helpers/press-counter.ts: 230 words a minute read, 1.2 s a
# press, 40 words a minute typed). A "press" is a tap, click or tick inside Creaton; a "field" is a box typed in; a
# "prompt" is a step outside Creaton (the wallet's connect or sign sheet, the phone's passkey sheet, switching apps).
#
# PRIVACY: no names, amounts or addresses here. The draft text below has placeholders in square brackets; counsel
# writes the real text. The ownership line is quoted word for word and must stay so.
import json

READ_WPM, PRESS_S, TYPE_WPM = 230, 1.2, 40
PROMPT_S = 6  # judgement: a wallet or passkey sheet, read and approved

DRAFT_TEXT = """
Replace your token agreement with Creaton Shares

What you backed. On [date] you paid [dollars] to [old company] for [old tokens] Creaton tokens at [price] each, under a
token agreement (a SAFT). Those tokens were never issued.

What this changes.
1. When you sign, your token agreement with [old company] ends. After that neither side owes the other anything under it.
2. Instead, [Creaton's legal entity: the Creaton series of the Marshall Islands DAO LLC] gives you [Shares] Shares of
   Creaton, out of 1,000,000,000. That is [percent] of Creaton.
3. How the number was worked out: [the rule, in one sentence, the same for every earlier backer].
4. Your Shares are held for you and released evenly over 365 days, starting on the day Creaton's market opens. Until
   then they cannot be sent or sold. If Creaton says it will never open a market, the 365 days start on that day.
5. There is no refund. The money you paid is not paid back.
6. What Creaton is now. [One paragraph: a place where people start projects alone, post what they shipped every week,
   take small amounts from backers at a price they set, and open an auction and a market when they have grown. Creaton
   itself is the first project on it.] It is not yet running with real money.
7. What your Shares give you. Buyers acquire ownership only: governance and exit. No dividends or revenue share, ever,
   unless they contribute and earn one.
8. Nothing is promised. The market may never open. Shares may end up worth nothing. Creaton will not run on a real
   network before an outside audit and a lawyer's review are finished.
9. Where your Shares go: [address]. Once they are given, this cannot be changed.
10. Who gives them: [entity name, registration number, address]. Questions: [contact].
11. [Law and disputes: counsel.]

By ticking "I have read all of this" and signing, you agree to everything above.
"""
TEXT_WORDS = len(DRAFT_TEXT.split())
SUMMARY_WORDS = 70  # the top card: what you backed, Shares, when they release, what replaces the agreement
ACCOUNT_BOX_WORDS = 60  # the sign-up box's words (name, age, terms lines) as the Join path shows them
WALLET_SHEET_WORDS = 0  # the wallet's own sheet is counted as a prompt, not as reading


def path(name, presses, fields, prompts, typed_words=0, extra_read=0, note=""):
    read = TEXT_WORDS + SUMMARY_WORDS + extra_read
    secs = read / READ_WPM * 60 + len(presses) * PRESS_S + typed_words / TYPE_WPM * 60 + len(prompts) * PROMPT_S
    return dict(name=name, presses=len(presses), fields=fields, prompts=len(prompts), read_words=read,
                minutes=round(secs / 60, 1), steps=presses, outside=prompts, note=note)


NEW = ["age tick", "terms tick", "Create (name pre-filled from the list)"]
PASSKEY = ["passkey sheet"]
WALLET = ["wallet: connect", "wallet: sign"]
paths = [
    path("A. Signed in, computer with a wallet extension",
         ["I have read all of this", "Sign with the wallet you paid from"], 0, WALLET),
    path("B. New to Creaton, computer with a wallet extension (hosted terms)",
         NEW + ["I have read all of this", "Sign with the wallet you paid from"], 0, PASSKEY + WALLET,
         extra_read=ACCOUNT_BOX_WORDS),
    path("C. New, phone: account in the phone's browser, signature in the wallet app's browser",
         NEW + ["I have read all of this", "Sign in your wallet app", "pick the wallet app", "Sign (in the wallet app)"],
         0, PASSKEY + ["switch to the wallet app"] + WALLET + ["switch back"], extra_read=ACCOUNT_BOX_WORDS,
         note="passkeys do not work inside wallet apps' browsers, so the account is made first in the phone's browser"),
    path("C'. Signed in, phone, wallet app",
         ["I have read all of this", "Sign in your wallet app", "pick the wallet app", "Sign (in the wallet app)"],
         0, ["switch to the wallet app"] + WALLET + ["switch back"]),
    path("D. Sign another way (hardware wallet, any signing tool), signed in",
         ["I have read all of this", "Sign another way", "Copy the message", "Send the signature"], 1,
         ["sign in the other tool"], typed_words=0, note="the field is a paste, not typing"),
    path("E. No wallet: sign with the Creaton account (the owner then confirms it is them), new",
         NEW + ["I have read all of this", "Sign with my Creaton account"], 0, PASSKEY,
         extra_read=ACCOUNT_BOX_WORDS, note="Shares go to the account's own wallet; the owner presses Confirm once"),
    path("F. A shared wallet (Safe): each owner up to the threshold, signed in",
         ["I have read all of this", "Sign as an owner of this shared wallet"], 0, WALLET,
         note="per owner; the server checks the shared wallet's own answer on its network once enough owners signed"),
    path("Optional: send the Shares to another wallet (proves that wallet is theirs)",
         ["Change where the Shares go", "Use this wallet"], 0, WALLET, note="added to any path above"),
]

print(f"Draft text: {TEXT_WORDS} words, about {TEXT_WORDS / READ_WPM:.1f} minutes to read in full (simulated)\n")
print(f"{'path':92} {'press':>5} {'field':>5} {'outside':>7} {'min':>5}")
for p in paths:
    print(f"{p['name']:92} {p['presses']:>5} {p['fields']:>5} {p['prompts']:>7} {p['minutes']:>5}")
    if p["note"]:
        print(f"    {p['note']}")

# The owner's side, for about 20 backers (sheet: 21 entries, one is the owner's own).
N = 20
owner = {
    "upload the list (choose the file, check the flags, sign and save)": 3,
    "copy each private link into their own email (one press each)": N,
    "confirm the person for each account-signed entry (judgement: at most the 8 entries with no usable address)": 8,
    "give Shares to everyone who signed, one batch (proposal and the wallet prompt)": 2,
    "give Shares one by one with today's Give Shares (4 presses each, plan section 6)": 4 * N,
}
print("\nOwner's side (simulated)")
for k, v in owner.items():
    print(f"  {v:>4}  {k}")

# The stored record for one signature: what counsel gets per backer. Sizes in bytes (simulated, JSON as stored).
typed = {
    "types": {
        "EIP712Domain": [{"name": "name", "type": "string"}, {"name": "version", "type": "string"}],
        "Agreement": [
            {"name": "summary", "type": "string"}, {"name": "paidFrom", "type": "address"},
            {"name": "dollarsPaidCents", "type": "uint256"}, {"name": "shares", "type": "uint256"},
            {"name": "release", "type": "string"}, {"name": "sharesTo", "type": "address"},
            {"name": "account", "type": "string"}, {"name": "textHash", "type": "bytes32"},
            {"name": "offer", "type": "bytes32"}, {"name": "signedOn", "type": "string"},
        ],
    },
    "primaryType": "Agreement",
    "domain": {"name": "Creaton: replace your token agreement", "version": "1"},
    "message": {
        "summary": "x" * 280, "paidFrom": "0x" + "0" * 40, "dollarsPaidCents": "1" * 9, "shares": "1" * 9,
        "release": "Held for you, then released evenly over 365 days from the day Creaton's market opens",
        "sharesTo": "0x" + "0" * 40, "account": "npub1" + "q" * 58, "textHash": "0x" + "0" * 64,
        "offer": "0x" + "0" * 64, "signedOn": "2026-11-18",
    },
}
record = {
    "version": 1, "scheme": "eip712", "typedData": typed, "textId": "0x" + "0" * 64, "signature": "0x" + "0" * 130,
    "signer": "0x" + "0" * 40, "check": {"how": "ecrecover"}, "receivedAt": 0, "entry": "0x" + "0" * 32,
}
size = len(json.dumps(record, separators=(",", ":")))
print(f"\nOne stored signature record: about {size} bytes plus the text it names ({len(DRAFT_TEXT.encode())} bytes, "
      f"stored once per text version). For {N} backers: about {(size * N) // 1024} KiB.")
