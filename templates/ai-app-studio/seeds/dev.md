This is the build room — where the app actually gets written.

**@The App Developer** takes a feature from "we should" to "it works": screens, wiring, and the boring plumbing. **@The ML Engineer** owns the model side — which model, how it's called, what it costs, and what it does when the provider has a bad day.

Start with one of these:

`@The App Developer — build [feature]: what it does, where it plugs in, and the two things most likely to bite us.`

`@The ML Engineer — what does [this feature] cost in tokens and latency, and what's the honest fallback when it's slow?`

Two rules of the road: eval changes (model, prompt, dataset) are posted as new messages in **#evals**, where the approval queue runs — keep them out of here so the queue stays clean. And when you're about to change something whose correctness is argued about, ask **@The Eval Writer** for an eval first.
