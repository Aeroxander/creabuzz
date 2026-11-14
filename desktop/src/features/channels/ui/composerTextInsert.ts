/**
 * Focus the channel composer and insert text at the caret through the
 * DOM-native editing path (the rich-text editor mirrors native input, so a
 * typed `@` opens the mention picker exactly like a keystroke). Used by the
 * empty-channel "Mention an agent" affordance.
 *
 * Returns true when the text was inserted. When insertion is unavailable the
 * composer is still focused, so the affordance degrades to "start typing" —
 * never a dead click.
 */
export function insertTextIntoComposer(
  composerRoot: HTMLElement | null | undefined,
  text: string,
): boolean {
  const editor = composerRoot?.querySelector<HTMLElement>(
    '[data-testid="message-input"]',
  );
  if (!editor) {
    return false;
  }
  editor.focus();
  try {
    return document.execCommand("insertText", false, text);
  } catch {
    // Some engines reject execCommand; the focus above still put the caret
    // in the composer.
    return false;
  }
}
