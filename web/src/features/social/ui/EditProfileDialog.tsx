import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { ProfileMetadata } from "@/features/profiles/lib/index-profiles";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import { type ProfilePatch, useUpdateProfile } from "../use-social-actions";

const FIELDS: {
  key: keyof ProfilePatch;
  label: string;
  multiline?: boolean;
}[] = [
  { key: "display_name", label: "Display name" },
  { key: "name", label: "Username" },
  { key: "about", label: "Bio", multiline: true },
  { key: "picture", label: "Avatar link" },
  { key: "banner", label: "Banner link" },
  { key: "website", label: "Website" },
];

function initial(
  profile?: ProfileMetadata,
): Record<keyof ProfilePatch, string> {
  return {
    display_name: profile?.display_name ?? "",
    name: profile?.name ?? "",
    about: profile?.about ?? "",
    picture: profile?.picture ?? "",
    banner: profile?.banner ?? "",
    website: profile?.website ?? "",
  };
}

/** Edit your profile in a native dialog. Fields this form doesn't show are kept. */
export function EditProfileDialog({
  open,
  onClose,
  profile,
}: {
  open: boolean;
  onClose: () => void;
  profile?: ProfileMetadata;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [values, setValues] = useState(() => initial(profile));
  const update = useUpdateProfile();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setValues(initial(profile));
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, profile]);

  const save = () =>
    update.mutate(values, {
      onSuccess: () => {
        toast.success("Profile updated");
        onClose();
      },
      onError: (error) =>
        toast.error(
          error instanceof Error
            ? error.message
            : "Couldn't save your profile.",
        ),
    });

  return (
    <dialog
      aria-labelledby="social-edit-profile-title"
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl border border-black/10 bg-white p-0 text-black backdrop:bg-black/50 dark:border-white/15 dark:bg-neutral-900 dark:text-white"
      data-testid="social-edit-profile"
      onClose={onClose}
      ref={ref}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="flex items-center justify-between border-b border-black/10 px-4 py-3 dark:border-white/10">
          <h2 className="text-lg font-bold" id="social-edit-profile-title">
            Edit profile
          </h2>
          <Button
            className="rounded-full px-5 font-semibold"
            data-testid="social-edit-profile-save"
            disabled={update.isPending}
            size="sm"
            type="submit"
          >
            Save
          </Button>
        </div>
        <div className="max-h-[70dvh] space-y-4 overflow-y-auto p-4">
          {FIELDS.map(({ key, label, multiline }) => (
            <div className="text-sm" key={key}>
              <label
                className="text-black/60 dark:text-white/60"
                htmlFor={`social-profile-${key}`}
              >
                {label}
              </label>
              {multiline ? (
                <textarea
                  className="mt-1 w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  id={`social-profile-${key}`}
                  onChange={(e) =>
                    setValues({ ...values, [key]: e.target.value })
                  }
                  rows={3}
                  value={values[key]}
                />
              ) : (
                <Input
                  className="mt-1"
                  id={`social-profile-${key}`}
                  onChange={(e) =>
                    setValues({ ...values, [key]: e.target.value })
                  }
                  value={values[key]}
                />
              )}
            </div>
          ))}
        </div>
      </form>
    </dialog>
  );
}
