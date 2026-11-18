import {
  serverInvesting,
  serverTrading,
} from "@creaton/core/client/server-settings.ts";

/**
 * Whether this server offers investing (backing rounds, Shares, trading). Only a server that says so in its info
 * document turns it on: unset or unanswered is off, and nothing about money is shown.
 */
export function investingOn(): boolean {
  return serverInvesting() === true;
}

/**
 * Whether buying and selling Shares in a project's pool is offered: only where investing is on and the server also says
 * `trading: true`. No server says so yet, so it is off by default; the build must also name the trade router.
 */
export function tradingOn(): boolean {
  return investingOn() && serverTrading() === true;
}
