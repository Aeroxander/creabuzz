/**
 * "Ban" on a message or a post, for the owner and admins. In an open community the people who write are not on the
 * People list, so this is how a moderator keeps a spammer out without waiting for a report.
 *
 * A hook rather than a button, because each surface draws its own action row: it says whether to offer Ban, and gives
 * the dialog to render once it is pressed.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { Modal } from "@/features/launchpad/ui/Modal";

import { useCanBan } from "../use-bans";
import { BanForm } from "./BanPanel";

export function useBanAuthor(
  author: string,
  name: string,
): { allowed: boolean; start: () => void; dialog: ReactNode } {
  const canBan = useCanBan();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const allowed = canBan(author);
  return {
    allowed,
    start: () => setOpen(true),
    dialog: open ? (
      <Modal label={`Ban ${name}`} onClose={() => setOpen(false)}>
        <h2 className="text-lg font-bold">Ban {name}</h2>
        <BanForm
          name={name}
          onCancel={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            void client.invalidateQueries({ queryKey: ["community-bans"] });
          }}
          pubkey={author}
        />
      </Modal>
    ) : null,
  };
}
