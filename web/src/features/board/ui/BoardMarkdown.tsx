import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { DecisionEmbeds } from "@/features/launchpad/ui/DecisionEmbeds";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";

/**
 * A post or reply's text. Links open in a new tab and never hand over the opener. Pictures show at most as tall as a
 * phone screen's half, and only from web addresses.
 */
export function BoardMarkdown({ text }: { text: string }) {
  return (
    <div className="break-words text-sm leading-relaxed text-foreground [&_a]:text-primary-ink [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_li]:ml-5 [&_ol]:list-decimal [&_p]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-secondary [&_pre]:p-2 [&_ul]:list-disc">
      <ReactMarkdown
        components={{
          a: ({ href, children }) => (
            <a href={href} rel="noopener noreferrer" target="_blank">
              {children}
            </a>
          ),
          img: ({ src, alt }) =>
            typeof src === "string" && /^https?:\/\//i.test(src) ? (
              <img
                alt={alt ?? ""}
                className="my-2 max-h-[28rem] max-w-full rounded-lg border object-contain"
                loading="lazy"
                referrerPolicy="no-referrer"
                src={rewriteRelayUrl(src)}
              />
            ) : null,
        }}
        remarkPlugins={[remarkGfm]}
      >
        {text}
      </ReactMarkdown>
      <DecisionEmbeds text={text} />
    </div>
  );
}
