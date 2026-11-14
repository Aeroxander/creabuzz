import assert from "node:assert/strict";
import test from "node:test";

import {
  notificationsOn,
  notifyBody,
  notifyPref,
  notifyStateLine,
  offerNotifications,
  setNotifyPref,
  shouldNotify,
} from "./browser-notify.ts";

const store = () => {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
};

test("the choice is kept per account and server; an unknown value is no choice", () => {
  const s = store();
  assert.equal(notifyPref(s, "wss://a", "ab"), null);
  assert.equal(setNotifyPref(s, "wss://a", "AB", "on"), true);
  assert.equal(notifyPref(s, "wss://a", "ab"), "on");
  assert.equal(notifyPref(s, "wss://a", "cd"), null);
  assert.equal(notifyPref(s, "wss://b", "ab"), null);
  s.setItem("creaton.notify.browser.wss://a|ef", "maybe");
  assert.equal(notifyPref(s, "wss://a", "ef"), null);
  assert.equal(setNotifyPref(null, "wss://a", "ab", "on"), false);
});

test("turning them on is offered only to someone who has not chosen and whose browser was not asked", () => {
  assert.equal(offerNotifications({ pref: null, permission: "default" }), true);
  for (const permission of ["granted", "denied", "unsupported"])
    assert.equal(offerNotifications({ pref: null, permission }), false);
  for (const pref of ["on", "off"])
    assert.equal(offerNotifications({ pref, permission: "default" }), false);
});

test("one is shown only when on, allowed, hidden, and the count went up", () => {
  const base = {
    pref: "on",
    permission: "granted",
    hidden: true,
    unread: 3,
    told: 2,
  };
  assert.equal(shouldNotify(base), true);
  assert.equal(shouldNotify({ ...base, pref: "off" }), false);
  assert.equal(shouldNotify({ ...base, pref: null }), false);
  assert.equal(shouldNotify({ ...base, permission: "default" }), false);
  assert.equal(shouldNotify({ ...base, permission: "denied" }), false);
  assert.equal(shouldNotify({ ...base, hidden: false }), false);
  assert.equal(shouldNotify({ ...base, told: 3 }), false);
  assert.equal(shouldNotify({ ...base, unread: 1 }), false);
  assert.equal(notificationsOn({ pref: "on", permission: "denied" }), false);
});

test("the words name a count and nothing else; the settings line says why it is off", () => {
  assert.equal(notifyBody(1), "1 new notification");
  assert.equal(notifyBody(4), "4 new notifications");
  assert.match(
    notifyStateLine({ pref: "on", permission: "denied" }),
    /blocking notifications/,
  );
  assert.match(
    notifyStateLine({ pref: "on", permission: "unsupported" }),
    /can't show/,
  );
  assert.match(notifyStateLine({ pref: "on", permission: "granted" }), /^On\./);
  assert.match(
    notifyStateLine({ pref: null, permission: "default" }),
    /^Off\./,
  );
});
