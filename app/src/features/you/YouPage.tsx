import { CREATE_ACCOUNT } from "@creaton/core/account/account-copy.ts";
import {
  clearPasskeySession,
  hasPasskeyIdentity,
  removePasskeyIdentity,
} from "@creaton/core/account/passkey-identity.ts";
import { forgetIdentity } from "@creaton/core/client/identity.ts";
import { serverWebPushKey } from "@creaton/core/client/server-settings.ts";
import { Link } from "@tanstack/react-router";
import {
  Bookmark,
  ChevronRight,
  EyeOff,
  KeyRound,
  LogOut,
  MessageSquare,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { ScreenHeader } from "../../app/BackHeader";
import { useAccount } from "../../lib/account";
import { nameOf, useProfiles } from "../../lib/profiles";
import { saveProfile } from "../../lib/profile-save";
import { useMutes } from "../../lib/mutes";
import { legacyScreensOn } from "../../lib/legacy";
import { investingOn } from "../../lib/server";
import { Button, ButtonLink } from "../../ui/button";
import { EmptyState } from "../../ui/empty-state";
import { Field, TextArea } from "../../ui/field";
import { Dialog, Sheet } from "../../ui/sheet";
import { Tabs } from "../../ui/tabs";
import { useToast } from "../../ui/toast";
import { BACKED_UP_KEY, RecoveryKeyPanel } from "../account/RecoveryKeyPanel";
import { ProjectCard } from "../home/ProjectCard";
import { SenderChoice } from "../money/SenderChoice";
import { NotificationsList } from "../notifications/NotificationsList";
import { ProfileHead } from "../profile/ProfilePage";
import { HiddenSheet } from "../room/HiddenSheet";
import { NOT_SAVED } from "../room/room-words";
import { forgetRoomDrafts } from "../room/use-draft";
import { forgetAllHiddenPictures } from "../pictures/hidden-pictures";
import { forgetAllReported } from "../safety/reported";
import { useProjectsBy } from "../profile/use-own-projects";

// What is planned, taken and finished on the projects this account holds, and what it is owed (the record only, no money call).
const NewsSection = lazy(() => import("../alerts/NewsSection"));
// Alerts when the app is closed (a short message when a task is planned, taken or ended): the card is drawn only where the
// server says it can send them.
const PushCard = lazy(() =>
  import("../alerts/push/PushCard").then((m) => ({ default: m.PushCard })),
);
// What this account holds across projects (money calls and ABIs load only where investing is on).
const YourSharesList = lazy(() => import("../pot/YourSharesList"));
// The old design's backing receipts: loaded only with the legacy-screens flag.
const LegacyReceipts = lazy(() =>
  import("../../legacy/LegacyPerson").then((m) => ({
    default: m.LegacyReceipts,
  })),
);
// Linking a wallet (milestone 7) carries the wallet proof's code, so it loads only where investing is on.
const LinkWallet = lazy(() =>
  import("../team/LinkWallet").then((m) => ({ default: m.LinkWallet })),
);

/** You: your profile, notifications, messages, your projects and your account. */
export function YouPage() {
  const { pubkey } = useAccount();
  if (!pubkey) return <SignedOut />;
  return <SignedIn me={pubkey} />;
}

function SignedOut() {
  return (
    <main className="screen mx-auto flex max-w-lg flex-col gap-6">
      <ScreenHeader title="You" />
      <EmptyState
        action={
          <div className="flex flex-col items-center gap-3">
            <ButtonLink data-testid="you-sign-up" to="/welcome">
              {CREATE_ACCOUNT}
            </ButtonLink>
            <Link
              className="link min-h-11 font-semibold"
              search={{ mode: "signin" }}
              to="/welcome"
            >
              I already have an account
            </Link>
          </div>
        }
        testId="you-signed-out"
        title="Make your account"
      >
        Follow projects, post, send messages and ask to join a team. It takes a
        name and a tap.
      </EmptyState>
    </main>
  );
}

function SignedIn({ me }: { me: string }) {
  const [tab, setTab] = useState("notifications");
  const [editing, setEditing] = useState(false);
  const projects = useProjectsBy(me).data ?? [];
  const profiles = useProfiles([me]).data;
  return (
    <main
      className="screen mx-auto flex max-w-lg flex-col gap-5"
      data-testid="you-page"
    >
      <ScreenHeader
        action={
          <Button
            data-testid="you-edit"
            onClick={() => setEditing(true)}
            size="sm"
            variant="secondary"
          >
            Edit
          </Button>
        }
        title="You"
      />
      <ProfileHead level="h2" pubkey={me} />
      <Link
        className="glass glass-text flex min-h-14 items-center gap-3 rounded-2xl px-4"
        data-testid="you-messages"
        to="/you/messages"
      >
        <MessageSquare aria-hidden="true" className="text-mint-ink" size={20} />
        <span className="flex-1 font-semibold">Messages</span>
        <ChevronRight aria-hidden="true" className="text-muted" size={20} />
      </Link>
      <Link
        className="glass glass-text flex min-h-14 items-center gap-3 rounded-2xl px-4"
        data-testid="you-saved"
        to="/you/saved"
      >
        <Bookmark aria-hidden="true" className="text-mint-ink" size={20} />
        <span className="flex-1 font-semibold">Saved posts</span>
        <ChevronRight aria-hidden="true" className="text-muted" size={20} />
      </Link>
      {legacyScreensOn() ? (
        <Suspense fallback={null}>
          <LegacyReceipts />
        </Suspense>
      ) : null}
      {investingOn() ? (
        <Suspense fallback={null}>
          <NewsSection />
        </Suspense>
      ) : null}
      {investingOn() && serverWebPushKey() ? (
        <Suspense fallback={null}>
          <PushCard me={me} />
        </Suspense>
      ) : null}
      {investingOn() ? (
        <Suspense fallback={null}>
          <YourSharesList />
        </Suspense>
      ) : null}
      {investingOn() ? <SenderChoice /> : null}
      {investingOn() ? (
        <Suspense fallback={null}>
          <LinkWallet me={me} />
        </Suspense>
      ) : null}
      <Tabs
        items={[
          {
            value: "notifications",
            label: "Notifications",
            content: <NotificationsList />,
          },
          {
            value: "projects",
            label: "Projects",
            content:
              projects.length === 0 ? (
                <EmptyState title="No projects yet">
                  Projects you start show here.
                </EmptyState>
              ) : (
                <div className="flex flex-col gap-3">
                  {projects.map((project) => (
                    <ProjectCard
                      key={project.coordinate}
                      profiles={profiles}
                      project={project}
                    />
                  ))}
                </div>
              ),
          },
          { value: "account", label: "Account", content: <AccountTab /> },
        ]}
        label="You"
        onValueChange={setTab}
        value={tab}
      />
      <EditProfileSheet
        initialName={
          nameOf(profiles, me) === "Someone" ? "" : nameOf(profiles, me)
        }
        hasProfile={Boolean(profiles?.[me])}
        initialAbout={profiles?.[me]?.about ?? ""}
        me={me}
        onOpenChange={setEditing}
        open={editing}
      />
    </main>
  );
}

function EditProfileSheet({
  me,
  open,
  onOpenChange,
  initialName,
  initialAbout,
  hasProfile,
}: {
  me: string;
  /** The person's profile was read: saving must then build on it, never start from empty. */
  hasProfile: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName: string;
  initialAbout: string;
}) {
  const [name, setName] = useState(initialName);
  const [about, setAbout] = useState(initialAbout);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  return (
    <Sheet
      onOpenChange={(next) => {
        if (next) {
          setName(initialName);
          setAbout(initialAbout);
        }
        onOpenChange(next);
      }}
      open={open}
      title="Your profile"
    >
      <Field
        label="Name"
        onChange={(e) => setName(e.target.value)}
        value={name}
      />
      <TextArea
        label="About you"
        onChange={(e) => setAbout(e.target.value)}
        rows={3}
        value={about}
      />
      <Button
        block
        disabled={!name.trim() || saving}
        onClick={() => {
          setSaving(true);
          saveProfile(me, { name, about }, { expectExisting: hasProfile })
            .then(() => {
              toast("Saved", "done");
              onOpenChange(false);
            })
            .catch((error: Error) => toast(error.message, "problem"))
            .finally(() => setSaving(false));
        }}
      >
        Save
      </Button>
    </Sheet>
  );
}

/** How long a sign-out waits for the server to forget the device before it goes on without it. */
const STOP_ALERTS_WAIT_MS = 5_000;

/**
 * Turn this device's alerts off for the account that is leaving. It has to come first: the server's forgetting is a call
 * the account signs, and the key is gone after sign-out. A browser that is no longer subscribed gets nothing more, so a
 * shared phone is never left showing one person's news to the next. It never holds a sign-out up for long and never throws.
 */
async function stopAlertsBeforeSignOut(me: string | null): Promise<void> {
  if (!me) return;
  try {
    const { alertsSavedBy, turnOff } = await import(
      "../alerts/push/push-device"
    );
    if (!alertsSavedBy(me)) return;
    await Promise.race([
      turnOff(me),
      new Promise((resolve) => setTimeout(resolve, STOP_ALERTS_WAIT_MS)),
    ]);
  } catch {
    // Nothing more can be done here: the sign-out goes on.
  }
}

function AccountTab() {
  const { pubkey } = useAccount();
  const [showKey, setShowKey] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const mutes = useMutes();
  const toast = useToast();
  return (
    <div className="flex flex-col gap-3" data-testid="account-tab">
      <Button
        block
        data-testid="you-hidden"
        onClick={() => setHiddenOpen(true)}
        variant="secondary"
      >
        <EyeOff aria-hidden="true" size={18} />
        {mutes.ready ? `Hidden people (${mutes.muted.size})` : "Hidden people"}
      </Button>
      <HiddenSheet
        hidden={[...mutes.muted]}
        onOpenChange={setHiddenOpen}
        onShowAgain={(pubkey) =>
          void mutes.showAgain(pubkey).catch(() => toast(NOT_SAVED, "problem"))
        }
        open={hiddenOpen}
        pending={mutes.pending}
        unknown={mutes.failed}
      />
      <Button block onClick={() => setShowKey(true)} variant="secondary">
        <KeyRound aria-hidden="true" size={18} />
        Save your recovery key
      </Button>
      <Button
        block
        data-testid="sign-out"
        onClick={() => setSigningOut(true)}
        variant="secondary"
      >
        <LogOut aria-hidden="true" size={18} />
        Sign out
      </Button>
      <Sheet
        description="Your recovery key signs you in on any device."
        onOpenChange={setShowKey}
        open={showKey}
        title="Save your recovery key"
      >
        <RecoveryKeyPanel onSaved={() => setShowKey(false)} />
      </Sheet>
      <Dialog
        description="Without your recovery key this account cannot come back on this device. Save it first if you have not."
        onOpenChange={setSigningOut}
        open={signingOut}
        testId="sign-out-dialog"
        title="Sign out?"
      >
        <div className="flex justify-end gap-2">
          <Button onClick={() => setSigningOut(false)} variant="ghost">
            Cancel
          </Button>
          <Button
            data-testid="sign-out-confirm"
            onClick={() => {
              void stopAlertsBeforeSignOut(pubkey).then(() => {
                clearPasskeySession();
                if (hasPasskeyIdentity()) removePasskeyIdentity();
                forgetIdentity();
                forgetRoomDrafts();
                forgetAllReported();
                forgetAllHiddenPictures();
                try {
                  localStorage.removeItem(BACKED_UP_KEY);
                } catch {
                  // Storage refused: there is nothing kept to remove.
                }
                // A full page load, as web/ does: it drops everything held in memory for this account (opened
                // messages, notifications, follows), so nothing of it stays readable on a shared phone.
                window.location.assign("/");
              });
            }}
            variant="secondary"
          >
            Sign out
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
