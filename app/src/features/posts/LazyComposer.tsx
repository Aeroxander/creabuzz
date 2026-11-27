import { lazy, type ComponentProps, Suspense, useState } from "react";

// The writing box loads the first time it is opened.
const ComposerSheet = lazy(() =>
  import("./Composer").then((m) => ({ default: m.ComposerSheet })),
);

/**
 * {@link ComposerSheet}, loaded when it is first opened and kept drawn after that, so closing it animates and focus goes back to
 * what opened it.
 */
export function LazyComposer(props: ComponentProps<typeof ComposerSheet>) {
  const [opened, setOpened] = useState(props.open);
  if (props.open && !opened) setOpened(true);
  if (!opened) return null;
  return (
    <Suspense fallback={null}>
      <ComposerSheet {...props} />
    </Suspense>
  );
}
