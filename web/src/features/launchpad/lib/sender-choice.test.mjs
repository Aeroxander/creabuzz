import assert from "node:assert/strict";
import { test } from "node:test";

import { SponsoredSenderUnavailableError } from "../../identity/lib/sponsoredSender.ts";
import { PaymasterDeniedError } from "../../identity/lib/zerodev.ts";
import { actingErrorMessage } from "./acting-account.ts";
import { senderErrorMessage } from "./sender-choice.ts";

test("a money panel's send failure says what actingErrorMessage says, never a vendor's dashboard", () => {
  const denied = new PaymasterDeniedError("policy cap reached");
  const said = senderErrorMessage(denied, "The exit was not sent.");
  assert.equal(said, actingErrorMessage(denied));
  assert.doesNotMatch(said, /ZeroDev|dashboard|Gas Policies|https?:/i);

  const unavailable = new SponsoredSenderUnavailableError({
    available: false,
    reason: "Passkey sign-in is not set up.",
    action: "Set it up from your profile menu.",
  });
  assert.equal(
    senderErrorMessage(unavailable, "x"),
    "Passkey sign-in is not set up. Set it up from your profile menu.",
  );
  // A sentence this app wrote keeps its words.
  assert.equal(
    senderErrorMessage(new Error("Your wallet is on another network."), "x"),
    "Your wallet is on another network.",
  );
  // Something thrown that is not an error at all is said with the panel's own words.
  assert.equal(
    senderErrorMessage("boom", "The exit was not sent."),
    "The exit was not sent.",
  );
});
