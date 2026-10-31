import { Link } from "@tanstack/react-router";

import { resolveUserName } from "@/features/profiles/use-profiles";

import { avatarName, bylineName } from "../lib/person-name";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { ServerImage } from "@/shared/ui/ServerImage";

import { displayText } from "../../feed/lib/feed-events";
import { DecisionEmbeds } from "../../launchpad/ui/DecisionEmbeds";
import { tokenize } from "../lib/content";
import { quotedPostState } from "../lib/timeline";
import { q96ToPrice } from "../../launchpad/lib/candles";
import { saleCurrencyFor } from "../../launchpad/lib/sale-currency";
import { formatPrice } from "../../launchpad/ui/CandlestickChart";
import { cashtagLabel, cashtagPrice } from "../lib/cashtag";
import { useMarketPrice } from "../../launchpad/use-market";
import { useCashtagOwners } from "../use-cashtags";
import { usePeople } from "../use-people";
import { useNotesById } from "../use-social-data";

const MAX_IMAGES = 4;
const MAX_QUOTES = 2;

function Mention({ pubkey }: { pubkey: string }) {
  const people = usePeople([pubkey]);
  return (
    <Link
      className="relative z-10 text-sky-700 hover:underline dark:text-sky-400"
      params={{ pubkey }}
      to="/u/$pubkey"
    >
      @{resolveUserName(people[pubkey], pubkey)}
    </Link>
  );
}

/** A trend line over a few prices. Decorative: the price is written beside it. */
function Spark({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const width = 36;
  const height = 12;
  const min = Math.min(...points);
  const span = Math.max(...points) - min || 1;
  const path = points
    .map(
      (p, i) =>
        `${((i / (points.length - 1)) * width).toFixed(1)},${(height - ((p - min) / span) * height).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      aria-hidden="true"
      className="inline-block align-middle"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      <polyline
        fill="none"
        points={path}
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

/**
 * `$TICKER`: a link to the launch that owns the ticker, or plain text when nobody has claimed it. The price beside
 * it is the last trade on the market once the token has traded and a price service is configured. Before that it is
 * only ever what is recorded: the highest price recent bids would pay, or the sale's starting price when nobody has
 * bid, which is not a market trade, and the label says so.
 */
function Cashtag({ symbol }: { symbol: string }) {
  const launch = useCashtagOwners().get(symbol);
  if (!launch) return <>${symbol}</>;
  return <ResolvedCashtag launch={launch} symbol={symbol} />;
}

function ResolvedCashtag({
  launch,
  symbol,
}: {
  launch: NonNullable<ReturnType<ReturnType<typeof useCashtagOwners>["get"]>>;
  symbol: string;
}) {
  const market = useMarketPrice(launch);
  const currency = saleCurrencyFor(
    launch.record.currency,
    launch.record.chainId,
  );
  const unit = currency.kind === "custom" ? "USDC" : currency.symbol;
  const price = cashtagPrice(
    { bids: launch.bids, floorPrice: launch.record.floorPrice },
    (q96) => q96ToPrice(q96, currency.decimals),
    market,
  );
  const shown = price ? { price, unit, text: formatPrice(price.latest) } : null;
  const label = cashtagLabel(symbol, launch, shown);
  return (
    <Link
      aria-label={label}
      className="relative z-10 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-emerald-800 hover:underline dark:text-emerald-300"
      data-testid="social-cashtag"
      params={{ launchId: launch.record.id }}
      search={{ action: undefined, author: launch.record.author }}
      title={label}
      to="/launchpad/$launchId"
    >
      ${symbol}
      {shown ? (
        <>
          {" "}
          <Spark points={shown.price.points} />{" "}
          <span className="text-xs" data-testid="social-cashtag-price">
            {shown.text} {shown.unit}
          </span>
        </>
      ) : null}
    </Link>
  );
}

/** One inline image; if it cannot load, it disappears instead of leaving an empty frame. */
function PostImage({ src }: { src: string }) {
  return (
    <ServerImage
      alt=""
      className="max-h-96 w-full object-cover"
      loading="lazy"
      referrerPolicy="no-referrer"
      src={src}
      unavailable="hide"
    />
  );
}

/** A quoted post, shown as a compact bordered card that opens the post. */
function QuoteCard({ id }: { id: string }) {
  const read = useNotesById([id]);
  const row = read.data?.[0];
  const author = row?.event.pubkey;
  const people = usePeople(author ? [author] : []);
  const state = quotedPostState({
    found: row !== undefined,
    isPending: read.isPending,
    isError: read.isError,
  });
  if (!row || !author || state !== "shown") {
    return (
      <div
        className="relative z-10 mt-3 rounded-xl border border-black/10 p-3 text-sm text-black/60 dark:border-white/10 dark:text-white/60"
        data-testid="social-quote-missing"
      >
        {state === "loading"
          ? "Loading the quoted post…"
          : state === "removed"
            ? "This post was removed."
            : "This post isn't available right now."}
      </div>
    );
  }
  const name = bylineName(people[author]);
  return (
    <div
      className="relative z-10 mt-3 overflow-hidden rounded-xl border border-black/10 p-3 transition-colors hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/[0.04]"
      data-testid="social-quote-card"
    >
      <div className="flex items-center gap-2 text-sm">
        <UserAvatar
          avatarUrl={people[author]?.picture ?? null}
          displayName={avatarName(people[author])}
          size="xs"
        />
        <Link
          className="truncate font-semibold text-black after:absolute after:inset-0 dark:text-white"
          params={{ id }}
          to="/social/post/$id"
        >
          {name}
        </Link>
        <span className="shrink-0 text-black/60 dark:text-white/60">
          · {shortRelativeTime(row.event.created_at)}
        </span>
      </div>
      <div className="mt-1 line-clamp-6">
        <PostContent embed={false} text={row.event.content} />
      </div>
    </div>
  );
}

/**
 * A post's text: links, hashtags and mentions are live, image links become
 * media, and quoted posts become cards. `nostr:` references are what other
 * Nostr clients render the same way.
 */
export function PostContent({
  text,
  embed = true,
}: {
  text: string;
  embed?: boolean;
}) {
  const tokens = tokenize(displayText(text));
  const images = tokens.flatMap((t) => (t.type === "image" ? [t.url] : []));
  const quotes = embed
    ? [
        ...new Set(tokens.flatMap((t) => (t.type === "event" ? [t.id] : []))),
      ].slice(0, MAX_QUOTES)
    : [];

  return (
    <>
      <p className="whitespace-pre-wrap break-words text-base text-black dark:text-white">
        {tokens.map((token, i) => {
          const key = `${token.type}-${i}`;
          switch (token.type) {
            case "text":
              return token.text;
            case "hashtag":
              return (
                <Link
                  className="relative z-10 text-sky-700 hover:underline dark:text-sky-400"
                  key={key}
                  params={{ tag: token.tag }}
                  to="/social/tag/$tag"
                >
                  #{token.tag}
                </Link>
              );
            case "cashtag":
              return <Cashtag key={key} symbol={token.symbol} />;
            case "mention":
              return <Mention key={key} pubkey={token.pubkey} />;
            case "link":
              return (
                <a
                  className="relative z-10 break-all text-sky-700 hover:underline dark:text-sky-400"
                  href={token.url}
                  key={key}
                  rel="noopener noreferrer nofollow"
                  target="_blank"
                >
                  {token.url.replace(/^https?:\/\//, "")}
                </a>
              );
            default:
              // Images and quoted posts render below the text.
              return null;
          }
        })}
      </p>
      {images.length > 0 ? (
        <div
          className={`mt-3 grid gap-0.5 overflow-hidden rounded-xl border border-black/10 dark:border-white/10 ${images.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}
        >
          {images.slice(0, MAX_IMAGES).map((src) => (
            <PostImage key={src} src={src} />
          ))}
        </div>
      ) : null}
      {quotes.map((id) => (
        <QuoteCard id={id} key={id} />
      ))}
      {embed ? (
        <div className="relative z-10">
          <DecisionEmbeds text={text} />
        </div>
      ) : null}
    </>
  );
}
