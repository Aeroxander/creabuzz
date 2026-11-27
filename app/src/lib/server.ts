import { serverInvesting } from "@creaton/core/client/server-settings.ts";

/**
 * Whether this server offers investing (backing rounds, Shares, trading). Only a server that says so in its info
 * document turns it on: unset or unanswered is off, and nothing about money is shown.
 */
export function investingOn(): boolean {
  return serverInvesting() === true;
}
