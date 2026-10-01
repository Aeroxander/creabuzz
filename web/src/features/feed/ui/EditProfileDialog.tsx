import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import type { Profile } from "../feed-model";
import { type ProfilePatch, useUpdateProfile } from "../use-social";

const FIELDS: {
  key: keyof ProfilePatch;
  label: string;
  multiline?: boolean;
}[] = [
  { key: "display_name", label: "Display name" },
  { key: "name", label: "Username" },
  { key: "about", label: "Bio", multiline: true },
  { key: "picture", label: "Avatar URL" },
  { key: "banner", label: "Banner URL" },
  { key: "website", label: "Website" },
];

function initialValues(profile?: Profile): Record<keyof ProfilePatch, string> {
  return {
    display_name: profile?.displayName ?? "",
    name: profile?.name ?? "",
    about: profile?.about ?? "",
    picture: profile?.picture ?? "",
    banner: profile?.banner ?? "",
    website: profile?.website ?? "",
  };
}

/** Native `<dialog>` editor for the viewer's kind 0. Unedited profile fields are preserved. */
export function EditProfileDialog({
  open,
  onClose,
  viewer,
  profile,
}: {
  open: boolean;
  onClose: () => void;
  viewer: string;
  profile?: Profile;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [values, setValues] = useState(() => initialValues(profile));
  const update = useUpdateProfile(viewer);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setValues(initialValues(profile));
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, profile]);

  function save() {
    update.mutate(values, {
      onSuccess: () => {
        toast.success("Profile updated");
        onClose();
      },
      onError: (error) => toast.error(error.message),
    });
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="edit-profile-title"
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl border bg-background p-0 text-foreground backdrop:bg-black/50"
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 id="edit-profile-title" className="text-xl font-bold">
            Edit profile
          </h2>
          <Button
            type="submit"
            size="sm"
            className="rounded-full px-5 font-bold"
            disabled={update.isPending}
          >
            Save
          </Button>
        </div>
        <div className="max-h-[70dvh] space-y-4 overflow-y-auto p-4">
          {FIELDS.map(({ key, label, multiline }) => (
            <div key={key} className="block text-sm text-muted-foreground">
              <label htmlFor={`profile-${key}`}>{label}</label>
              {multiline ? (
                <textarea
                  id={`profile-${key}`}
                  value={values[key]}
                  rows={3}
                  onChange={(e) =>
                    setValues({ ...values, [key]: e.target.value })
                  }
                  className="mt-1 w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-[15px] text-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                />
              ) : (
                <Input
                  id={`profile-${key}`}
                  value={values[key]}
                  onChange={(e) =>
                    setValues({ ...values, [key]: e.target.value })
                  }
                  className="mt-1 h-10 text-[15px] text-foreground"
                />
              )}
            </div>
          ))}
        </div>
      </form>
    </dialog>
  );
}
