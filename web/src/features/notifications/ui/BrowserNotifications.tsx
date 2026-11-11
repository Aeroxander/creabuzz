/**
 * Browser notifications (`lib/browser-notify.ts`): the notifier that shows one when the count of new things goes up
 * while the page is hidden, the small offer shown after a meaningful action, and the one switch on the
 * Notifications page. The browser is asked for permission only from a button press.
 */

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { APP_NAME } from "@/shared/constants/brand";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";

import {
  MEANINGFUL_EVENT,
  NOTIFY_PREF_EVENT,
  type NotifyPermission,
  type NotifyPref,
  notificationsOn,
  notifyBody,
  notifyPref,
  notifyStateLine,
  offerNotifications,
  setNotifyPref,
  shouldNotify,
} from "../lib/browser-notify";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function permissionNow(): NotifyPermission {
  return typeof Notification === "undefined"
    ? "unsupported"
    : Notification.permission;
}

/** The person's choice and the browser's permission, kept current across the page. */
function useNotifyState(me: string) {
  const server = relayWsUrl();
  const read = useCallback(
    () => ({
      pref: notifyPref(storage(), server, me),
      permission: permissionNow(),
    }),
    [server, me],
  );
  const [state, setState] = useState(read);
  useEffect(() => {
    const sync = () => setState(read());
    sync();
    window.addEventListener(NOTIFY_PREF_EVENT, sync);
    return () => window.removeEventListener(NOTIFY_PREF_EVENT, sync);
  }, [read]);
  const choose = useCallback(
    (pref: NotifyPref) => {
      setNotifyPref(storage(), server, me, pref);
      // Said for every listener on the page; each reads the choice and the permission again.
      window.dispatchEvent(new Event(NOTIFY_PREF_EVENT));
    },
    [server, me],
  );
  /** Ask the browser (from a button press), then keep "on" only if it said yes. */
  const turnOn = useCallback(async () => {
    let permission = permissionNow();
    if (permission === "default") {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = "denied";
      }
    }
    choose(permission === "granted" ? "on" : "off");
    return permission;
  }, [choose]);
  return { ...state, choose, turnOn };
}

/** Shows a browser notification when the count of new things goes up while the page is hidden. Renders nothing. */
function Notifier({ me, unread }: { me: string; unread: number }) {
  const { pref, permission } = useNotifyState(me);
  const navigate = useNavigate();
  // What the person has already been told about, or has seen with the page in view.
  const told = useRef(unread);
  useEffect(() => {
    const seen = () => {
      if (!document.hidden) told.current = unread;
    };
    seen();
    document.addEventListener("visibilitychange", seen);
    return () => document.removeEventListener("visibilitychange", seen);
  }, [unread]);
  useEffect(() => {
    if (unread < told.current) told.current = unread;
    if (
      !shouldNotify({
        pref,
        permission,
        hidden: document.hidden,
        unread,
        told: told.current,
      })
    )
      return;
    told.current = unread;
    try {
      // One at a time: a newer count replaces the older notification.
      const note = new Notification(APP_NAME, {
        body: notifyBody(unread),
        tag: "creaton-inbox",
      });
      note.onclick = () => {
        window.focus();
        void navigate({ to: "/social/notifications" });
        note.close();
      };
    } catch {
      // The browser would not show it: the bell on the page still counts.
    }
  }, [unread, pref, permission, navigate]);
  return null;
}

/** After a meaningful action, once: an offer to turn notifications on. It asks the browser only when pressed. */
function NotifyOffer({ me }: { me: string }) {
  const { pref, permission, choose, turnOn } = useNotifyState(me);
  const [open, setOpen] = useState(false);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const offer = () => setOpen(true);
    window.addEventListener(MEANINGFUL_EVENT, offer);
    return () => window.removeEventListener(MEANINGFUL_EVENT, offer);
  }, []);
  if (blocked)
    return (
      <div
        className="glass fixed inset-x-3 bottom-20 z-40 mx-auto flex max-w-md flex-wrap items-center gap-2 rounded-2xl border p-3 text-sm shadow-lg md:bottom-4"
        data-testid="notify-offer-blocked"
        role="status"
      >
        <p className="min-w-0 flex-1">
          Your browser didn't allow notifications. You can turn them on later on
          the Notifications page.
        </p>
        <Button
          onClick={() => setBlocked(false)}
          size="sm"
          type="button"
          variant="outline"
        >
          OK
        </Button>
      </div>
    );
  if (!open || !offerNotifications({ pref, permission })) return null;
  return (
    <section
      aria-label="Turn on notifications"
      className="glass fixed inset-x-3 bottom-20 z-40 mx-auto flex max-w-md flex-wrap items-center gap-2 rounded-2xl border p-3 text-sm shadow-lg md:bottom-4"
      data-testid="notify-offer"
    >
      <p className="min-w-0 flex-1">
        Want a heads-up when there's news for you? It works while a tab of the
        app is open.
      </p>
      <Button
        data-testid="notify-offer-on"
        onClick={() =>
          void turnOn().then((result) => {
            setOpen(false);
            if (result !== "granted") setBlocked(true);
          })
        }
        size="sm"
        type="button"
      >
        Turn on
      </Button>
      <Button
        data-testid="notify-offer-no"
        onClick={() => {
          choose("off");
          setOpen(false);
        }}
        size="sm"
        type="button"
        variant="ghost"
      >
        No thanks
      </Button>
    </section>
  );
}

/** Mounted once beside the bell: the notifier and the offer. */
export function BrowserNotifications({
  me,
  unread,
}: {
  me: string;
  unread: number;
}) {
  return (
    <>
      <Notifier me={me} unread={unread} />
      <NotifyOffer me={me} />
    </>
  );
}

/** The one switch, on the Notifications page. */
export function NotifyToggle({ me }: { me: string }) {
  const { pref, permission, choose, turnOn } = useNotifyState(me);
  const on = notificationsOn({ pref, permission });
  const unavailable = permission === "unsupported" || permission === "denied";
  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-black/10 px-4 py-3 text-sm dark:border-white/10"
      data-testid="notify-toggle-row"
    >
      <div className="min-w-0 flex-1">
        <p className="font-semibold" id="notify-toggle-label">
          Browser notifications
        </p>
        <p
          className="text-xs text-muted-foreground"
          data-testid="notify-toggle-state"
          id="notify-toggle-state"
        >
          {notifyStateLine({ pref, permission })}
        </p>
      </div>
      <Button
        aria-checked={on}
        aria-describedby="notify-toggle-state"
        aria-labelledby="notify-toggle-label"
        data-testid="notify-toggle"
        disabled={unavailable && !on}
        onClick={() => (on ? choose("off") : void turnOn())}
        role="switch"
        size="sm"
        type="button"
        variant={on ? "default" : "outline"}
      >
        {on ? "On" : "Off"}
      </Button>
    </div>
  );
}
