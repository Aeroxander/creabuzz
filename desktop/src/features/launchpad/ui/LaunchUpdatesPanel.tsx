import type { Launch } from "@/features/launchpad/launchpadModels";

export function LaunchUpdatesPanel({ launch }: { launch: Launch }) {
  if (launch.updates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No updates yet. Founders post signed updates — they land here and can
        cross-post into the community channels.
      </p>
    );
  }
  return (
    <ol className="flex max-w-2xl flex-col gap-3">
      {launch.updates.map((update) => (
        <li
          key={update.id}
          className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3"
        >
          <h4 className="text-sm font-semibold">{update.title}</h4>
          <p className="mt-0.5 text-2xs tabular-nums text-muted-foreground">
            {new Date(update.createdAt * 1000).toLocaleString()}
          </p>
          <p className="mt-2 whitespace-pre-wrap text-sm">{update.body}</p>
          {update.links.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {update.links.map((link) => (
                <a
                  key={link}
                  className="text-2xs text-primary hover:underline"
                  href={link}
                  rel="noreferrer"
                  target="_blank"
                >
                  {link}
                </a>
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
