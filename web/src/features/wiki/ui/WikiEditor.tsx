import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { useEffect } from "react";

/**
 * WYSIWYG markdown editor (TipTap + markdown bridge) bound to the wiki's
 * live content state: edits serialize to markdown (→ save/P2P), and
 * external changes (peer edits, snapshot pulls) re-parse into the editor.
 */
export function WikiEditor({
  content,
  onChange,
}: {
  content: string;
  onChange: (markdown: string) => void;
}) {
  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content,
    editorProps: {
      attributes: {
        class:
          "prose prose-sm max-w-none p-4 min-h-[50vh] outline-none dark:prose-invert [&_pre]:overflow-x-auto",
      },
    },
    onUpdate: ({ editor: e }) => {
      const markdown = (
        e.storage as unknown as { markdown: { getMarkdown(): string } }
      ).markdown.getMarkdown();
      if (markdown !== content) onChange(markdown);
    },
  });

  // External content (peer edits / snapshot pull) → re-parse into the editor.
  useEffect(() => {
    if (!editor) return;
    const markdown = (
      editor.storage as unknown as { markdown: { getMarkdown(): string } }
    ).markdown.getMarkdown();
    if (content !== markdown) {
      editor.commands.setContent(content);
    }
  }, [content, editor]);

  return editor ? <EditorContent editor={editor} /> : null;
}
