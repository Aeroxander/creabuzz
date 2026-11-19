/**
 * The contracts this app knows a send may go to: the ones a project's numbers name, the dollar token its rounds take,
 * and the build's own Launcher and Router. The passkey account only sends to these. It catches this app's own mistakes and
 * keeps a person from signing a call to a contract the app never read; it does not stop an attacker, who builds
 * operations in their own code, and the dollar token comes from the configured node, so it is only as honest as that node.
 * The server's own allow-list (see `docs/next-version/PHONE-PATH-REPORT.md`) is the one that holds.
 */

const known = new Set<string>();

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Remember contracts this app has read from the server's numbers or the chain; anything that is not an address is ignored. */
export function rememberSendTargets(
  addresses: Iterable<string | null | undefined>,
): void {
  for (const address of addresses)
    if (typeof address === "string" && ADDRESS.test(address))
      known.add(address.toLowerCase());
}

/** The build's own contracts (`VITE_CREATON_LAUNCHER`, `VITE_CREATON_DOLLAR` for the faucet, `VITE_CREATON_ROUTER`). */
function builtTargets(env: Record<string, unknown>): string[] {
  return [
    env.VITE_CREATON_LAUNCHER,
    env.VITE_CREATON_DOLLAR,
    env.VITE_CREATON_ROUTER,
  ].filter(
    (value): value is string =>
      typeof value === "string" && ADDRESS.test(value),
  );
}

/** Every contract a passkey send may go to now, lower-case. */
export function knownSendTargets(
  env: Record<string, unknown> = import.meta.env,
): ReadonlySet<string> {
  return new Set([...known, ...builtTargets(env).map((a) => a.toLowerCase())]);
}

/** Forget what was remembered (a test, or another community's contracts). */
export function forgetSendTargets(): void {
  known.clear();
}
