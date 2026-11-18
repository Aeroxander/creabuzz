/** A work area's or submission's short name, quietly beside its title: it is what a submission names. */
export function ShortName({ name }: { name: string | null | undefined }) {
  if (!name) return null;
  return (
    <span className="font-mono text-xs font-normal text-muted-foreground">
      {" "}
      {name}
    </span>
  );
}
