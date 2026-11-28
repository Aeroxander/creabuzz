import type { Locator, Page } from "@playwright/test";

/**
 * Counts what a person does on a path through the app, so a spec can say how long the path is: every click, tap and
 * tick is one press, and every box that is typed in is one field. Specs press and type through the counter, not around
 * it, so the count is of what the spec really did on the real screens.
 *
 * Copied from web/tests/helpers/press-counter.ts for the new app (app/), with plan v2's budgets added below.
 *
 * `solo-path-guard.spec.ts` (mocked) and `e2e-real/solo-path.spec.ts` (a real server) both use it to hold the solo
 * founder's path from Home to the first piece of work done to the budget in `SOLO_PATH_BUDGET`; `project-join.spec.ts`
 * (mocked), `e2e-real/project-loop.spec.ts` (a real server) and `e2e-real/join-path.spec.ts` (a real server with the
 * hosted settings) hold the join path to the `JOIN_PATH_*` budgets and `ACCEPT_PATH_BUDGET`.
 */

/** The most a person alone may do between Home and "First piece of work done" (the build plan, section 2). */
export const SOLO_PATH_BUDGET = { presses: 8, fields: 4 } as const;

/**
 * The most a stranger does on a project's link to be "Asked to join", by where they start (the next-version plan,
 * section 8, milestone 0). Every press and every typed box counts, the sign-up included; the plan's "2 presses" counted
 * only the two Ask presses and left the sign-up out.
 *
 * - Already signed in: one press, nothing typed.
 * - Signed out on an open server with no terms: Ask, Create, and the name typed. The press of Ask is remembered across
 *   sign-up (`markAskAfterSignUp`), so there is no second Ask.
 * - Signed out on the hosted settings (terms of use, privacy note and the age box, `BUZZ_AGE_ATTESTATION_REQUIRED`):
 *   Ask, the age tick, the terms tick, Create, and the name typed.
 */
export const JOIN_PATH_BUDGET = { presses: 1, fields: 0 } as const;
export const JOIN_PATH_SIGNED_OUT_BUDGET = { presses: 2, fields: 1 } as const;
export const JOIN_PATH_HOSTED_BUDGET = { presses: 4, fields: 1 } as const;

/** What the founder does to accept an ask: one press on Accept, nothing typed. */
export const ACCEPT_PATH_BUDGET = { presses: 1, fields: 0 } as const;

/** The press and field budgets of the app's journeys, each held by a test. */
export const PLAN_V2_BUDGETS = {
  start: { presses: 3, fields: 3 },
  back: { presses: 2, fields: 1 },
  takeMoneyBack: { presses: 2, fields: 0 },
  weeklyUpdate: { presses: 2, fields: 1 },
  /** Measured in milestone 0: the hosted sign-up (age and terms boxes) included. */
  join: JOIN_PATH_HOSTED_BUDGET,
} as const;

/** Reading speed, press time and typing speed behind the estimate (the same ones the first walk of the app used). */
const WORDS_READ_PER_MINUTE = 230;
const SECONDS_PER_PRESS = 1.2;
const WORDS_TYPED_PER_MINUTE = 40;

export interface PathCounts {
  presses: number;
  fields: number;
  typedWords: number;
  typedChars: number;
  readWords: number;
  /** About how long the path takes a person: reading, pressing and typing. Not the time the server takes. */
  estimatedSeconds: number;
  log: string[];
}

export const estimateSeconds = (counts: {
  readWords: number;
  presses: number;
  typedWords: number;
}) =>
  Math.round(
    (counts.readWords / WORDS_READ_PER_MINUTE) * 60 +
      counts.presses * SECONDS_PER_PRESS +
      (counts.typedWords / WORDS_TYPED_PER_MINUTE) * 60,
  );

const wordsOf = (text: string) => text.split(/\s+/).filter(Boolean).length;

export class PressCounter {
  presses = 0;
  fields = 0;
  typedWords = 0;
  typedChars = 0;
  readWords = 0;
  readonly log: string[] = [];

  /** One click or tap. */
  async press(target: Locator, label: string) {
    await target.click();
    this.presses += 1;
    this.log.push(`press ${this.presses}: ${label}`);
  }

  /** One tick of a box. */
  async tick(target: Locator, label: string) {
    await target.check();
    this.presses += 1;
    this.log.push(`press ${this.presses}: tick "${label}"`);
  }

  /** One box typed in. A box that is filled twice is two fields: the second try counts. */
  async type(target: Locator, text: string, label: string) {
    await target.fill(text);
    this.fields += 1;
    this.typedChars += text.length;
    this.typedWords += wordsOf(text);
    this.log.push(`field ${this.fields}: ${label} = "${text}"`);
  }

  /** Add the words a person must read on the screen as it is now (see `mustReadWords`). */
  async read(page: Page, label: string, focus?: Locator) {
    const words = await mustReadWords(page, focus);
    this.readWords += words;
    this.log.push(`read ${words} words: ${label}`);
    return words;
  }

  counts(): PathCounts {
    return {
      presses: this.presses,
      fields: this.fields,
      typedWords: this.typedWords,
      typedChars: this.typedChars,
      readWords: this.readWords,
      estimatedSeconds: estimateSeconds(this),
      log: [...this.log],
    };
  }

  /** The counts as one line, for a run's output. */
  summary(label: string) {
    const c = this.counts();
    return `[path] ${label}: ${c.presses} presses, ${c.fields} typed fields (${c.typedWords} words), ${c.readWords} words read, about ${c.estimatedSeconds} s`;
  }
}

/**
 * The words a person must read on the screen as it is now: the headings, the first sentence under the first heading,
 * every label, every button and link-button, and one line of help per field. An open dialog is the region when there
 * is one; otherwise `focus`, otherwise the page's main area. Text that is not drawn (screen-reader-only text) and text
 * of boxes that are not on the screen is not counted. This is the measure the first walk of the app used, so numbers
 * from before and after the rework can be put side by side.
 */
export function mustReadWords(page: Page, focus?: Locator): Promise<number> {
  return (async () => {
    const handle =
      focus && (await focus.count()) > 0
        ? await focus.first().elementHandle()
        : null;
    return page.evaluate((focusEl) => {
      const countWords = (s: string) =>
        (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’./:-]*/gu) ?? []).length;
      const shown = (el: Element | null): boolean => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) return false;
        const anyEl = el as Element & {
          checkVisibility?: (o: object) => boolean;
        };
        if (anyEl.checkVisibility)
          return anyEl.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          });
        return true;
      };
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(
        shown,
      );
      const modal = dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
      const main = document.getElementById("app-main") ?? document.body;
      const region: Element = modal ?? (focusEl as Element | null) ?? main;

      const blockOf = (el: Element | null): Element | null => {
        let cur = el;
        while (cur && cur !== document.body) {
          const d = getComputedStyle(cur).display;
          if (!d.startsWith("inline") && d !== "contents") return cur;
          cur = cur.parentElement;
        }
        return cur;
      };
      const visibleText = (root: Element): string => {
        const lines: string[] = [];
        let lastBlock: Element | null = null;
        let lastParent: Element | null = null;
        let line = "";
        const flush = () => {
          const t = line.replace(/\s+/g, " ").trim();
          if (t) lines.push(t);
          line = "";
        };
        const walker = document.createTreeWalker(
          root,
          NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        );
        let node: Node | null = walker.currentNode;
        while (node) {
          if (node.nodeType === Node.TEXT_NODE) {
            const textNode = node as Text;
            const raw = textNode.data;
            const parent = textNode.parentElement;
            if (!raw.trim() && raw.length > 0 && line && !line.endsWith(" "))
              line += " ";
            if (
              raw.trim() &&
              parent &&
              !["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "OPTION"].includes(
                parent.tagName,
              ) &&
              shown(parent)
            ) {
              const range = document.createRange();
              range.selectNodeContents(textNode);
              const drawn = [...range.getClientRects()].some(
                (r) => r.width > 1 && r.height > 1,
              );
              if (drawn) {
                const block = blockOf(parent);
                if (block !== lastBlock) {
                  flush();
                  lastBlock = block;
                }
                line += (parent !== lastParent ? " " : "") + raw;
                lastParent = parent;
              }
            }
          }
          node = walker.nextNode();
        }
        flush();
        return lines.join("\n");
      };

      const picked = new Set<Element>();
      const parts: string[] = [];
      const inside = (el: Element) =>
        [...picked].some((p) => p !== el && p.contains(el));
      const add = (el: Element, firstSentenceOnly = false) => {
        if (picked.has(el) || inside(el) || !shown(el)) return;
        let t = visibleText(el).replace(/\s+/g, " ").trim();
        if (firstSentenceOnly) t = t.split(/(?<=[.!?])\s/)[0] ?? t;
        if (!t) return;
        picked.add(el);
        parts.push(t);
      };
      region.querySelectorAll('h1,h2,h3,h4,[role="heading"]').forEach((el) => {
        add(el);
      });
      const firstHeading = region.querySelector("h1,h2,h3");
      const intro = firstHeading?.nextElementSibling;
      if (intro && intro.tagName === "P") add(intro, true);
      region.querySelectorAll("label,legend").forEach((el) => {
        add(el);
      });
      region
        .querySelectorAll(
          'button,[role="button"],[role="tab"],summary,a[class*="inline-flex"]',
        )
        .forEach((el) => {
          add(el);
        });
      for (const field of region.querySelectorAll("input,textarea,select")) {
        const type = (field.getAttribute("type") ?? "text").toLowerCase();
        if (
          ["hidden", "checkbox", "radio", "file"].includes(type) ||
          !shown(field)
        )
          continue;
        const described = field.getAttribute("aria-describedby");
        const byId = described
          ? document.getElementById(described.split(" ")[0])
          : null;
        if (byId && shown(byId)) {
          add(byId, true);
          continue;
        }
        let box: Element | null = field.parentElement;
        for (let up = 0; up < 3 && box && box !== region; up += 1) {
          const help = [...box.querySelectorAll("p")].find(
            (p) => shown(p) && !picked.has(p) && !inside(p),
          );
          if (help) {
            add(help, true);
            break;
          }
          box = box.parentElement;
        }
      }
      return parts.reduce((sum, part) => sum + countWords(part), 0);
    }, handle);
  })();
}
