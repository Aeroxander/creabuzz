/**
 * The sentences of the report sheet and of hiding a person, in one place.
 */

/** The five plain choices of a report, and the record type each is sent as (the server's own types). */
export const REPORT_CHOICES = [
  { value: "spam", label: "Spam" },
  { value: "impersonation", label: "Pretending to be someone" },
  { value: "profanity", label: "Rude or harmful" },
  { value: "illegal", label: "Illegal" },
  { value: "other", label: "Something else" },
] as const;
export type ReportChoice = (typeof REPORT_CHOICES)[number]["value"];
export const REPORT_DONE =
  "Thanks. The people who run this server will look at it.";

export const HIDES_UNKNOWN =
  "Your list of hidden people could not be opened, so someone you hid may show here.";
export const NOT_SAVED = "That was not saved. Try again.";

export const HIDE_DONE = (name: string) =>
  `You will not see posts by ${name} any more. Only you stop seeing them.`;
