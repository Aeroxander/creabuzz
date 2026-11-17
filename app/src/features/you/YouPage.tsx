import { CREATE_ACCOUNT } from "@creaton/core/account/account-copy.ts";
import {
  clearPasskeySession,
  hasPasskeyIdentity,
  removePasskeyIdentity,
} from "@creaton/core/account/passkey-identity.ts";
import { forgetIdentity } from "@creaton/core/client/identity.ts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronRight,
  KeyRound,
  LogOut,
  MessageSquare,
  Receipt,
} from "lucide-react";
import { useState } from "react";
import { ScreenHeader } from "../../app/BackHeader";
import { announceAccountChange, useAccount } from "../../lib/account";
import { nameOf, useProfiles } from "../../lib/profiles";
import { saveProfile } from "../../lib/profile-save";
import { investingOn } from "../../lib/server";
import { Button, buttonClass } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import { Field, TextArea } from "../../ui/field";
import { Dialog, Sheet } from "../../ui/sheet";
import { Tabs } from "../../ui/tabs";
import { useToast } from "../../ui/toast";
import { RecoveryKeyPanel } from "../account/RecoveryKeySheet";
import { ProjectCard } from "../home/ProjectCard";
import { NotificationsList } from "../notifications/NotificationsList";
import { ProfileHead } from "../profile/ProfilePage";
import { useProjectsBy } from "../profile/use-own-projects";

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
            <Link
              className={buttonClass()}
              data-testid="you-sign-up"
              to="/welcome"
            >
              {CREATE_ACCOUNT}
            </Link>
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
      <ProfileHead pubkey={me} />
      <Link
        className="glass flex min-h-14 items-center gap-3 rounded-2xl px-4"
        data-testid="you-messages"
        to="/you/messages"
      >
        <MessageSquare aria-hidden="true" className="text-mint-ink" size={20} />
        <span className="flex-1 font-semibold">Messages</span>
        <ChevronRight aria-hidden="true" className="text-muted" size={20} />
      </Link>
      {investingOn() ? (
        <Card
          className="flex items-start gap-3"
          data-testid="receipts-placeholder"
        >
          <Receipt
            aria-hidden="true"
            className="mt-0.5 text-mint-ink"
            size={20}
          />
          <div>
            <p className="font-semibold">Backing receipts</p>
            <p className="text-sm text-muted">
              What you paid, the Shares you hold and which are free, and what
              you can still take back show here once the server reads them.
            </p>
          </div>
        </Card>
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
}: {
  me: string;
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
          saveProfile(me, { name, about })
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
  const navigate = useNavigate();
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
              announceAccountChange();
              setSigningOut(false);
              void navigate({ to: "/" });
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
