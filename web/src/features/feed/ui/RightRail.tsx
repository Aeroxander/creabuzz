import { Link, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useState } from "react";

import { relayWsUrl } from "@/shared/lib/relay-url";
import { ConnectButton } from "@/features/repos/ui/ConnectButton";
import { useSuggestedUsers, useTrending } from "../use-discover";
import { useProfiles, useViewerPubkey } from "../use-feed";
import { PersonRow } from "./PersonRow";

function relayHost(): string {
  try {
    return new URL(relayWsUrl()).host;
  } catch {
    return relayWsUrl();
  }
}

export function SearchBox({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  const navigate = useNavigate();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const q = value.trim();
        if (q) navigate({ to: "/search", search: { q } });
      }}
      className="relative"
    >
      <Search className="pointer-events-none absolute top-1/2 left-4 h-[18px] w-[18px] -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search"
        aria-label="Search"
        className="h-11 w-full rounded-full border border-transparent bg-muted/60 pr-4 pl-11 text-[15px] outline-hidden placeholder:text-muted-foreground focus:border-primary focus:bg-background"
      />
    </form>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl bg-muted/40">
      <h2 className="px-4 pt-3 pb-1 text-xl font-extrabold">{title}</h2>
      {children}
    </section>
  );
}

function TrendingCard() {
  const hashtags = useTrending().data?.hashtags.slice(0, 5) ?? [];
  if (hashtags.length === 0) return null;
  return (
    <Card title="Trending">
      <ul>
        {hashtags.map(({ tag, count }) => (
          <li key={tag}>
            <Link
              to="/tag/$tag"
              params={{ tag }}
              className="block px-4 py-2 transition-colors hover:bg-foreground/[0.04]"
            >
              <div className="font-bold leading-5">#{tag}</div>
              <div className="text-[13px] text-muted-foreground">
                {count} {count === 1 ? "person" : "people"} posting
              </div>
            </Link>
          </li>
        ))}
      </ul>
      <Link
        to="/explore"
        className="block px-4 py-3 text-[15px] text-primary hover:bg-foreground/[0.04]"
      >
        Show more
      </Link>
    </Card>
  );
}

function WhoToFollowCard() {
  const viewer = useViewerPubkey();
  const suggested = useSuggestedUsers(viewer, 3).data ?? [];
  const profiles = useProfiles(suggested.map((s) => s.pubkey)).data;
  if (suggested.length === 0) return null;
  return (
    <Card title="Who to follow">
      {suggested.map((s) => (
        <PersonRow
          key={s.pubkey}
          pubkey={s.pubkey}
          profile={profiles?.get(s.pubkey)}
          viewer={viewer}
        />
      ))}
      <Link
        to="/explore"
        className="block px-4 py-3 text-[15px] text-primary hover:bg-foreground/[0.04]"
      >
        Show more
      </Link>
    </Card>
  );
}

/** Right rail: search, trending hashtags, who to follow, and the community card. */
export function RightRail() {
  return (
    <div className="flex flex-col gap-4">
      <SearchBox />
      <TrendingCard />
      <WhoToFollowCard />
      <section className="rounded-2xl bg-muted/40 p-4">
        <h2 className="text-xl font-extrabold">This community</h2>
        <p className="mt-1 break-all text-sm text-muted-foreground">
          {relayHost()}
        </p>
        <p className="mt-3 text-[15px] leading-5">
          Posts here are Nostr notes. Open the community in Buzz for chat,
          channels and agents.
        </p>
        <ConnectButton className="mt-4 rounded-full" />
      </section>
    </div>
  );
}
