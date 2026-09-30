/**
 * Entry point for using this browser's account on the desktop app. This used
 * to be a paste-your-key box; the handoff now runs through the link-device
 * flow — the desktop app shows a link ("Sign in with browser"), this browser
 * confirms which account would be shared, and the account passes over
 * encrypted to a one-time key. The button takes the reader to that flow's
 * page, which explains the step if no link is open yet.
 */
export function WebIdentityHandoffCard() {
  return (
    <div
      className="mt-4 border-t border-black/10 pt-3 dark:border-white/10"
      data-testid="web-identity-handoff"
    >
      <p className="text-xs font-medium text-black/60 dark:text-white/60">
        Use this account on the desktop app
      </p>
      <p className="mt-1.5 text-2xs leading-4 text-black/55 dark:text-white/55">
        On the desktop app, choose Sign in with browser and open the link it
        shows. This browser confirms the account before anything is shared — no
        key ever gets pasted anywhere.
      </p>
      <button
        type="button"
        data-testid="web-identity-sign-in"
        onClick={() => window.location.assign("/link-device")}
        className="mt-2 rounded-md border border-input bg-background px-3 py-1 text-xs font-medium"
      >
        Sign in with browser
      </button>
    </div>
  );
}
