# Project structure: helping teams without business experience work together (proposal, 2026-10-31)

**Status:** step 1 (taking work on, Now and Not doing) built as D154; steps 2 to 5 are proposals. Nothing here changes
a contract; everything is app copy, defaults and signed records on the server.

## The problem

A contributor project today gives its people a clear money loop: work areas with "what finished looks like", submit,
review, an award vote, and "Needs you" for whoever's turn it is. Everything around that loop is left to the team:

- **Who is on what.** The founder manages every work area. Work is claimed after it is done, so two people can do the
  same piece, and nobody can say "I'm on this until Friday".
- **What matters now.** Open work is sorted by closing date. There is no list of priorities and no list of what the team
  has decided not to do.
- **Decisions that are not payments.** A decision in the app is always a vote on a transaction. "We use Figma, not
  Canva" or "we target teachers first" lives in chat, if anywhere, with no owner and no date to check it.
- **A rhythm.** Updates are free text, with no schedule and no sign when a project has gone quiet. In the pilot, the
  organiser has to message everyone each day by hand.
- **Newcomers.** A newcomer sees "How it works" and the open work, and nothing that tells them how this team works.

Experienced people organise this by habit. People new to running projects don't, and that is where things become
chaotic. The tools for some of it are already built but hidden from contributor projects: the community Tasks board
(owner, due date, priority), "Building together" on the Overview, and Milestones.

## What we take from *The Effective Executive*

Drucker argues that effectiveness is a handful of habits anyone can learn, not a talent. Five of them fit a small open
team, and each one can become a default in the app rather than advice:

1. **Contribution before effort.** Each person says what they will deliver that changes the project's results, for whom
   and by when, and the team can question it.
2. **First things first.** Work on one or two things at a time, choose out loud what not to do, and regularly ask of
   old work: "if we weren't doing this, would we start it now?"
3. **Decisions are not done until someone acts on them.** A decision names what it must achieve, who carries it out,
   by when, and who must be told, with a date to check whether it worked. Good decisions come from disagreement, so
   the strongest case against is heard before it is made. A problem seen twice gets a standing rule instead of being
   decided again.
4. **Build on strengths.** Match people to work by what they have actually delivered, not by a list of skills or by
   avoiding weaknesses. If someone misses, release the work without blame.
5. **Results are outside.** Users, readers and buyers are what count. Activity inside the project is cost. Reports
   should say what changed for them.

The book also warns against things a tool could easily do wrong: too many meetings, agreement treated as quality,
rating people's "potential", "let's study it more" as a way of not deciding, and keeping crises heroic instead of
making them routine. The proposal below avoids all of them. Following the copy standard, the app never names the book;
it just has the habits.

## The proposal: a working rhythm built into the project

Five pieces, all signed records on the server, shown on the project page. Each one is a short form with sensible
defaults, never a process to learn first.

### 1. "I'm taking this on": reserve work before doing it (contribution, strengths)

On an open work area, **Take this on** asks three things: what you will deliver, who will use it, and by when (default
two weeks). The card then shows "Ana is on this until 14 Nov". When the date passes without a submission, the
reservation lapses, the card says the work is open again, and nobody is blamed. Reserving gives no Shares and no
rights: the award still comes only from review and the vote. A newcomer's first suggestion comes from this record:
work areas close to what they have delivered before.

*Prevents:* two people doing the same thing; work nobody knows is happening; newcomers not knowing where to start.

### 2. "Now" and "Not doing" (first things first)

The Overview leads with **Now**: at most three priorities, each linked to a work area or decision, with one person
named against each. Under it is a short **Not doing** list, so dropped ideas are visible rather than lingering. The
founder sets both at the start, holders can propose changes, and every four weeks "Needs you" asks the founder
whether each priority is still worth doing.

*Prevents:* everyone working on their own favourite thing; old work carried on by habit.

### 3. Team decisions: a decision note (effective decisions)

A **decision note** records what the vote screens can't: something decided that is not a payment. Fields:

- what we decided, and what it must achieve;
- the strongest case against, and one alternative we considered (both required);
- who acts on it, and by when;
- who must know;
- a check date (default four weeks), when "Needs you" asks the person who acts: did it do what we expected?

A note can be marked **"this keeps coming up"**, which makes it a standing rule, listed on the project's rules page
(reusing the board rules we already have). Notes are records of the team's choice. They are not votes and move no
money; a note can link to a vote when one is needed.

*Prevents:* the same argument every week; decisions nobody carries out; decisions made without hearing the objection.

### 4. A weekly check-in (results are outside)

Updates become a short weekly check-in with four prompts: **what changed for the people we serve**, what was finished,
what's next, and what's stuck and who could unstick it. The founder chooses the day at the start. A project with no
check-in for 10 days shows "Quiet since …" on its card and in "Needs you" for the founder. "Stuck" items appear in the
named person's "Needs you". This is also what demo day reads from: a project with a run of check-ins and finished work
has a story to tell.

*Prevents:* projects going quiet without anyone noticing; reports that list effort rather than results.

### 5. A newcomer's first week

Joining asks one question, **"What would you like to contribute?"** It shows on their profile and to the founder,
followed by three steps in order: read Now and the rules, take on one small piece, and join the next check-in. It does
not ask for a skills list or a job title.

*Prevents:* people joining, looking around and leaving; the founder having to explain the same things to everyone.

## Order to build in

1. **Taking this on** and **Now / Not doing**. These cover the most chaos for the least work: both are small records
   shown on cards that already exist.
2. **Decision notes** with check dates and standing rules.
3. **Weekly check-in** and "Quiet since". The pilot runbook's daily manual message shrinks to a check of "Needs you".
4. **A newcomer's first week.**
5. **Decide what to do with the hidden parts.** If the Tasks board, "Building together" and Milestones overlap with
   1–3, either fold them in or remove them. We should not end up with two ways to say who is on what.

Each piece needs a server record type (an event kind) and one or two screens. None needs the contracts, which stay
frozen until after the pilots.

## Deliberately left out

- **Meeting tools.** Teams can talk anywhere. The decision note is what has to come out of a meeting.
- **Ratings of people.** Strength is shown as what someone delivered and how it was reviewed, never as a score.
- **Time tracking.** It is useful for one person reviewing their own habits, but it is surveillance as a team feature.
- **Required forms everywhere.** Only two things are required: the decision note's case against and its owner. The
  rest are prompts with defaults.

## Questions for you

1. Should **Now** be the founder's to set (holders can propose changes) or a holder vote from the start?
2. Should a reservation be **exclusive** (others can't submit the same piece while it is held) or just visible?
3. Is the check-in **weekly** for every project, or chosen at the start (weekly or every two weeks)?
4. Which other resources should shape this? Useful candidates are ones about running volunteer or open-source projects,
   writing clear decisions, and onboarding.
