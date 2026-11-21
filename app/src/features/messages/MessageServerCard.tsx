/**
 * The press that lets people on other apps message this person here: it adds this server to their public list of message
 * servers, and takes it off again. Said plainly before it is pressed: the list is public.
 */
import { failureWords } from "@creaton/core/client/readable-error.ts";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { useToast } from "../../ui/toast";
import {
  SERVER_OFF_DONE,
  SERVER_OFF_WORDS,
  SERVER_ON_DONE,
  SERVER_ON_WORDS,
  SERVER_UNKNOWN,
} from "./messages-words";
import { useMessageServers } from "./use-message-servers";

export function MessageServerCard() {
  const servers = useMessageServers();
  const toast = useToast();
  if (servers.isPending) return null;
  const turn = (on: boolean) =>
    servers.change.mutate(on, {
      onSuccess: () => toast(on ? SERVER_ON_DONE : SERVER_OFF_DONE, "done"),
      onError: (error) =>
        toast(
          failureWords(error, "That was not saved. Try again.").text,
          "problem",
        ),
    });
  return (
    <Card
      className="flex flex-col gap-3"
      data-testid="message-server"
      tone="plain"
    >
      {servers.isError ? (
        <>
          <p className="text-sm text-muted">{SERVER_UNKNOWN}</p>
          <div>
            <Button
              onClick={() => void servers.refetch()}
              size="sm"
              variant="secondary"
            >
              Try again
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-muted">
            {servers.on ? SERVER_ON_WORDS : SERVER_OFF_WORDS}
          </p>
          <div>
            <Button
              data-testid="message-server-toggle"
              disabled={servers.change.isPending}
              onClick={() => turn(!servers.on)}
              size="sm"
              variant={servers.on ? "ghost" : "secondary"}
            >
              {servers.on ? "Turn off" : "Turn on"}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
