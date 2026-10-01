export function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-sm px-8 py-16 text-center">
      <h2 className="text-3xl font-extrabold">{title}</h2>
      <p className="mt-2 text-[15px] text-muted-foreground">{body}</p>
    </div>
  );
}
