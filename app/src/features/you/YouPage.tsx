import { CREATE_ACCOUNT } from "@creaton/core/account/account-copy.ts";
import {
  clearPasskeySession,
  hasPasskeyIdentity,
  removePasskeyIdentity,
} from "@creaton/core/account/passkey-identity.ts";
import { forgetIdentity } from "@creaton/core/client/identity.ts";
import { Link } from "@tanstack/react-router";
import { ChevronRight, KeyRound, LogOut, MessageSquare } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { ScreenHeader } from "../../app/BackHeader";
import { useAccount } from "../../lib/account";
import { nameOf, useProfiles } from "../../lib/profiles";
import { saveProfile } from "../../lib/profile-save";
import { legacyScreensOn } from "../../lib/legacy";
import { investingOn } from "../../lib/server";
import { Button, ButtonLink } from "../../ui/button";
import { EmptyState } from "../../ui/empty-state";
import { Field, TextArea } from "../../ui/field";
import { Dialog, Sheet } from "../../ui/sheet";
import { Tabs } from "../../ui/tabs";
import { useToast } from "../../ui/toast";
import { BACKED_UP_KEY, RecoveryKeyPanel } from "../account/RecoveryKeySheet";
import { ProjectCard } from "../home/ProjectCard";
import { SenderChoice } from "../money/SenderChoice";
import { NotificationsList } from "../notifications/NotificationsList";
import { ProfileHead } from "../profile/ProfilePage";
import { useProjectsBy } from "../profile/use-own-projects";

// What is planned, taken and finished on the projects this account holds, and what it is owed (the record only, no money call).
const NewsSection = lazy(() => import("../alerts/NewsSection"));
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

function AccountTab() {
  const [showKey, setShowKey] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  return (
    <div className="flex flex-col gap-3" data-testid="account-tab">
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
        description="A passkey signs in only on this device."
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
              clearPasskeySession();
              if (hasPasskeyIdentity()) removePasskeyIdentity();
              forgetIdentity();
              try {
                localStorage.removeItem(BACKED_UP_KEY);
              } catch {
                // Storage refused: there is nothing kept to remove.
              }
              // A full page load, as web/ does: it drops everything held in memory for this account (opened
              // messages, notifications, follows), so nothing of it stays readable on a shared phone.
              window.location.assign("/");
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
