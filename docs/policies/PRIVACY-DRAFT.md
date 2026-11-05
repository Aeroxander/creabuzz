# Privacy note

Last updated: [date]

## Who we are

[Operator name and legal form] runs this Creaton server at [address] and decides what is done with your data. In data protection law that makes us the controller. This note says what we keep, why, who else sees it, and what you can ask us to do. Write to us at [email].

- [Representative for people in the EU or UK: counsel to choose between naming one, or stating that none is needed because the operator is in the EU or does not offer the service to people there.]
- [Controller details: counsel to confirm which legal entity or person is the controller.]

## Age

You must be 18 or older to use this service. People under 18 may not use it. We do not knowingly keep data about anyone under 18. At sign-up you confirm your age in a box; we do not check it and we do not keep your answer. If we learn that someone under 18 has an account, we may close it and delete what we hold about them on our server (see "Your rights" for what stays). If you are a parent or guardian and think this has happened, write to [email].

## What is public

Everything you post in public places is public by design: your profile (name, picture, description), posts, replies, votes, boards you start and join, and who you follow. It is signed with your key and can be copied by other servers and apps that use the same open protocol (Nostr). Anything you do on a blockchain (a wallet address, a vote, a claim, Shares you hold) is public and permanent; nobody, including us, can delete it. On this server "public" means visible to the members who are signed in.

## What we keep on our server

This server and its backups run on [hosting provider and country].

- The public records above, so we can show them. We keep them until you or a moderator remove them, or you ask us to delete your data.
- Pictures you upload. We strip location and camera data from them.
- **Messages** (in the main menu): end-to-end encrypted with your key. We store them but cannot read what they say; we can see whose accounts they are between and when they were sent.
- **Everything inside a community**, its private rooms and boards and its direct messages included: these are **not** end-to-end encrypted. They are protected on the way to us and stored on our server, where the people who run it can read them. We read them only to keep the service running, to handle a report, or when the law requires it. When someone reports a message, the community's moderators who handle the report see it.
- [Disk encryption: owner to state after checking with the hosting provider whether the server's disks are encrypted, and say so here, or delete this line.]
- Proof that you agreed to the terms, when you join by invite link: your public key, the version of the terms, and the time. Other sign-ups leave a note only in your own browser.
- Technical logs. They record when a connection opens and closes, the public key of the account that signed in, errors, and each use of the AI helpers (who and how many bytes). The address a connection comes from is probably our own proxy's, not yours. Our web server software keeps no access log, but its error lines may include an IP address. Logs are kept by size, not by time: each service keeps its latest five files of 10 MB and writes over the oldest. [Visitor IP addresses in logs: owner to confirm on the live server whether they appear, and say so here.]
- A security record, kept as a chain so that changes show: for each item stored, which account sent it, what kind it is, in which room and when. It also records sign-ins and failed sign-ins, people added or removed, and uploads. [How long the security record is kept: owner and counsel to set a period or criteria; nothing deletes it by age today.]
- Short-lived counters: whether you are online (about three minutes) and how many messages you have sent in the last minute.
- Reports you or others send to moderators, and moderators' actions. The person reported does not see who reported. Moderators see it, and a report passed on to the person who runs the server is seen by them. [How long reports and moderators' actions are kept: owner and counsel to set a period after a report closes, or the criteria; nothing deletes them by age today.]
- Backups of all of the above, with a copy of the server's settings (its passwords and keys included), so the service can be restored after a failure. They are kept for [number] days in [where backups are kept]. The backup script does not encrypt them. [How copies kept elsewhere are protected: owner to say.] Something deleted here stays in the backups until they expire.
- [If error reporting is switched on:] error reports from the app go from your browser to [name of the error collector]. They contain the page address, a short error message and a technical trace, with keys and account addresses taken out. They do not contain your key, and the collector sees your IP address.

We do not sell your data, show ads or use advertising trackers.

## Why we use your data

These are our reasons for using your data, and the legal basis for each.

- Running your account and showing your posts: [legal basis: counsel to choose between contract, legitimate interest, consent or legal obligation].
- Keeping the service secure and working (logs, security record, limits, backups): [legal basis: counsel to choose between contract, legitimate interest, consent or legal obligation].
- Handling reports, appeals and legal requests: [legal basis: counsel to choose between contract, legitimate interest, consent or legal obligation].
- Keeping proof that you agreed to the terms: [legal basis: counsel to choose between contract, legitimate interest, consent or legal obligation].
- Passing steps to the services below so the app works: [legal basis: counsel to choose between contract, legitimate interest, consent or legal obligation].
- The AI helpers, if this server has them: [legal basis: counsel to choose between contract, legitimate interest or consent].
- Error reports, if switched on: [legal basis: counsel to choose between legitimate interest or consent].

## Your key and your device

Your key, settings and drafts are stored in your browser, along with a note of the terms version you agreed to, your server address and unread marks. Clearing your browser data removes them; save your recovery key first.

- If you sign up with a passkey on a device that supports it, your key is made again each time you sign in and is not stored.
- Otherwise the key stays in your browser's storage, with the lock for it stored beside it. In effect it is unprotected. This is how it works for a key you create or import, and for a passkey that only locks the app and cannot make the key. Anyone who can use your device or browser, or run harmful code in it, can take your account. If your device is compromised, your account is too.
- We recommend a passkey that makes the key at sign-in (or a wallet, where this server offers one), and saving your recovery key somewhere safe and offline. The recovery key is plain text. Anyone who has it can act as you, so keep it private.
- "Sign out and forget" removes the key from that browser.

## Other services

Some steps go through other companies. For each one we say what it sees, whether it acts on our behalf (a processor) or on its own account (an independent controller), and how data that leaves your country is protected. We pass them only what each step needs.

- **The chain node for the page**, [name of the page's chain node provider]: the app in your browser asks it for public blockchain records, so it sees your IP address and which accounts and projects you look at. [If this server does not set its own node on the test network, the app uses a public default node, publicnode.com: owner to confirm which applies.]
  - Role: [processor or independent controller: counsel to choose].
  - Transfer outside your country: [counsel to choose the safeguard between an adequacy decision, standard contractual clauses or another mechanism, and name the country].
- **The chain node for our server**, [name of the server's chain node provider]: our server asks it to check a passkey account when you link it to your name. It sees our server's IP address, your account's address and the signed text, not your IP address.
  - Role: [processor or independent controller: counsel to choose].
  - Transfer outside your country: [counsel to choose the safeguard between an adequacy decision, standard contractual clauses or another mechanism, and name the country].
- **The AI service**, [name of the AI service this server is set up to use], [if this server has one switched on]: the AI helpers (checking your work before you submit it, the "Help me fill this in" questions, drafting a check note, and the follow-up questions and summary before a vote) send what you typed there, with the project details the helper names beside its button, from our server to that service. The AI service sees that text, not your key or your IP address. Our server notes that you used it and how much, to count it against your allowance, and logs who used it and how many bytes, not the text. If the service returns an error, a short part of its error message is logged. Its answer is shown only to you until you choose to save or post something. What the AI service keeps, and for how long, is set by its own terms: [what those terms say, or a link to them].
  - Role: [processor or independent controller: counsel to choose].
  - Transfer outside your country: [counsel to choose the safeguard between an adequacy decision, standard contractual clauses or another mechanism, and name the country].
- **ZeroDev**, for passkey accounts: each on-chain step you take from a passkey account goes from your browser through ZeroDev's bundler, and its paymaster covers the fee when our sponsor policy allows. ZeroDev sees your account's address, the step and your IP address. [How long ZeroDev keeps this: owner to say after checking its terms.]
  - Role: [processor or independent controller: counsel to choose].
  - Transfer outside your country: [counsel to choose the safeguard between an adequacy decision, standard contractual clauses or another mechanism, and name the country].
- **The error collector**, if error reporting is switched on, sees your IP address when your browser sends a report.
  - Role: [processor or independent controller: counsel to choose].
  - Transfer outside your country: [counsel to choose the safeguard between an adequacy decision, standard contractual clauses or another mechanism, and name the country].
- **Our hosting provider** stores everything on our server.
  - Role: [processor or independent controller: counsel to choose].
  - Transfer outside your country: [counsel to choose the safeguard between an adequacy decision, standard contractual clauses or another mechanism, and name the country].
- **Your passkey** is kept by your device or password manager (for example Apple, Google or Microsoft) under their own terms. We never see it. If this server offers a browser wallet, its maker's terms apply to it.
- **Pictures and links hosted elsewhere.** A picture someone posts from another site (in a profile or a post) loads straight from that site when you view it, so that site sees your IP address and when you looked. A link takes you to its site.

## Automatic checks and decisions

No AI and no score decides your reward, your Shares, your standing or your access by itself on this server. People decide, and some rules then run without a person looking each time, such as a submission that lapses when nobody settles it, limits on how fast you can post, and refused file types. The terms list them in the section "Automatic checks and rules". The AI helpers send what you type to the AI service (see above) and only give advice. If weekly Share sales open, a published member score could decide who may bid. This note will change before that.

You can ask a person to look at an automatic outcome that affects you, and give your view. Write to [email]. [Whether any of these rules is a decision based only on automated processing that has a legal or similarly significant effect: counsel to confirm.]

## Your rights

Depending on where you live (for example under the GDPR) you can ask us to:

- give you a copy of the data we hold about you, in a form you can use elsewhere;
- correct it (you can edit your profile yourself in the app);
- delete it;
- restrict it, so that we only store it while you challenge its accuracy or our reasons for using it;
- stop using it for a reason of ours (object);
- stop using it where you gave your consent (withdraw consent; this does not undo what was done before). [Uses that rely on consent: counsel to list them, or say there are none.]
- have a person look at an automatic outcome (see above).

Write to [email]. A person on our team handles each request by hand and answers within [number] days. We first ask you to prove it is you from inside the app. Today a person makes your copy and sends it to you. [You can download your data from the app.]

We can delete what is on our server: your posts and profile, your room memberships, reactions, wallet links and read marks. We cannot delete copies on other servers or anything on a blockchain. Backups keep it until they expire. Reports about you and records of moderators' actions, the security record and usage counts are not removed when we delete your account. You can also complain to your data protection authority.

## Changes

If this note changes, we post the change in General and the date above changes. [We also tell you directly in the app before a change takes effect.]
