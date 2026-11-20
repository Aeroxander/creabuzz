/**
 * Catches a part of the page whose code failed to load (a phone network that dropped, or a new version put up while the page was
 * open), so that part says so and the rest of the page, and Take out with it, stays. A part that is only a helper (a sheet, a
 * background task) is `quiet`: it draws nothing when it fails. The only way back from a failed load is a new page load, so that
 * is what the press does.
 */
import { Component, type ReactNode } from "react";
import { Button } from "./button";
import { Card } from "./card";

export const CHUNK_FAILED =
  "This part of the page could not load. Your money is not affected.";

interface Props {
  children: ReactNode;
  /** Draw nothing when the part fails (a sheet, a background helper). */
  quiet?: boolean;
}

export class ChunkBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.quiet) return null;
    return (
      <Card
        className="flex flex-col gap-2 p-3"
        data-testid="chunk-failed"
        role="alert"
      >
        <p className="text-sm">{CHUNK_FAILED}</p>
        <div>
          <Button
            onClick={() => window.location.reload()}
            size="sm"
            variant="secondary"
          >
            Reload the page
          </Button>
        </div>
      </Card>
    );
  }
}
