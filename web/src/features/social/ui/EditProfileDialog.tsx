import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { ProfileMetadata } from "@/features/profiles/lib/index-profiles";
import { ProfilePictureField } from "@/features/identity/ui/ProfilePictureField";
import { pictureLinkProblem } from "@/features/identity/lib/picture-check";
import { withNameFollowing } from "@/features/identity/lib/profile-names";
import { failureWords } from "@/shared/lib/readable-error";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import { type ProfilePatch, useUpdateProfile } from "../use-social-actions";

const FIELDS: {
  key: keyof ProfilePatch;
  label: string;
  multiline?: boolean;
}[] = [
  { key: "display_name", label: "Name" },
  { key: "about", label: "Bio", multiline: true },
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
  const [pictureUploading, setPictureUploading] = useState(false);
  const pictureProblem = pictureLinkProblem(values.picture, profile?.picture);

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

  const save = () => {
    if (pictureUploading || pictureProblem) return;
    update.mutate(withNameFollowing(values, profile), {
      onSuccess: () => {
        toast.success("Profile updated");
        onClose();
      },
      onError: (error) =>
        toast.error(
          failureWords(error, "Couldn't save your profile. Try again.").text,
        ),
    });
  };

  return (
    <dialog
      aria-labelledby="social-edit-profile-title"
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl glass-dialog border p-0 text-foreground backdrop:bg-black/50 backdrop:backdrop-blur-sm"
      data-testid="social-edit-profile"
      onClose={onClose}
      // A press on the backdrop (the dialog element itself, outside the form) closes it, as Escape does.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !update.isPending)
          onClose();
      }}
      ref={ref}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="flex items-center gap-2 border-b border-black/10 px-4 py-3 dark:border-white/10">
          <Button
            aria-label="Close"
            className="-ml-2 rounded-full"
            data-testid="social-edit-profile-close"
            disabled={update.isPending}
            onClick={onClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X aria-hidden className="h-5 w-5" />
          </Button>
          <h2
            className="mr-auto text-lg font-bold"
            id="social-edit-profile-title"
          >
            Edit profile
          </h2>
          <Button
            className="rounded-full px-5 font-semibold"
            data-testid="social-edit-profile-save"
            disabled={
              update.isPending || pictureUploading || pictureProblem !== null
            }
            size="sm"
            type="submit"
          >
            Save
          </Button>
        </div>
        <div className="max-h-[70dvh] space-y-4 overflow-y-auto p-4">
          <fieldset className="text-sm">
            <legend className="text-black/60 dark:text-white/60">
              Picture
            </legend>
            <div className="mt-1">
              {open ? (
                <ProfilePictureField
                  idPrefix="social-profile-picture"
                  onChange={(picture) =>
                    setValues((current) => ({ ...current, picture }))
                  }
                  onUploadingChange={setPictureUploading}
                  saved={profile?.picture}
                  value={values.picture}
                />
              ) : null}
            </div>
          </fieldset>
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
