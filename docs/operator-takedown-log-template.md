# Request log (one page per request)

Copy this file to `LOG.md` inside the request's folder in `~/takedowns` (see "Requests from the police, a court or
another authority" in `operator-takedown-and-data-requests.md`). Fill it in as you go. It holds personal data and may
hold an order not to disclose: keep it private, outside `backups/` and outside the git checkout. Dates are UTC, written
`YYYY-MM-DD`. A blank line that matters is better than a guess.

Folder name: `YYYY-MM-DD-<type>-<short name>`. Types: `authority`, `preservation`, `copyright`, `counter`, `illegal`,
`person`, `other`.

## 1. The request

- Case folder:
- Type:
- Arrived (date, how: email, post, phone, in the app):
- From (name, body, role, official address and phone found independently):
- Reference or case number:
- What they ask for (one or two lines):
- Deadline (date) and how to answer:
- Related case (for example the original notice of a counter-notice):

## 2. Is it valid? (one line each)

- Who issued it, and how I confirmed that:
- Kind of document (court order, warrant, subpoena, preservation letter, informal request, other):
- Law or power it relies on:
- Person, account or content it names (public key or post link), and how I matched it:
- Data and dates in scope:
- Does it forbid telling the person? (quote the words, and the date it ends if it says):
- Counsel asked (date, who, what they said):
- Decision (answer, answer in part, ask to narrow, refuse, ask for time) and who made it:

## 3. What I did (add a line as each step happens)

| Date | Step | Detail |
| --- | --- | --- |
|  | Content removed in the app / media removed (hashes) |  |
|  | Rows exported (file, `sha256sum`) |  |
|  | Held: prune job paused / backups copied (file names) / logs copied |  |
|  | Counter-notice passed to the complainant |  |
|  | Waiting window: starts, ends |  |
|  | Reply sent (to whom, what, how, `sha256sum` of each file) |  |
|  | Person told (how), or why not and until when |  |
|  | Content put back (what, how) |  |

## 4. What was sent

- Files sent (name and `sha256sum`), all kept in `response/`:
- Left out on purpose, and why:
- Not held by the server, as I told them:

## 5. Holds

- Hold requested until (date or "until released in writing"):
- What is held, and where (rows, backup files, logs):
- Deletions I postponed because of it:
- Released (date, by whom, in writing where). Prune job restored on (date):

## 6. Closed

- Closed on (date) by:
- Repeat-infringer ledger updated (`~/takedowns/repeat-infringers.md`), if a copyright case:
- Anything counsel or the owner still has to decide:
