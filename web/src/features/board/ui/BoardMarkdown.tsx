import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { DecisionEmbeds } from "@/features/launchpad/ui/DecisionEmbeds";

/** A post or reply's text. Links open in a new tab and never hand over the opener. */
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
        }}
        remarkPlugins={[remarkGfm]}
      >
        {text}
      </ReactMarkdown>
      <DecisionEmbeds text={text} />
    </div>
  );
}
