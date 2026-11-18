import { APP_NAME } from "@creaton/core/brand.ts";

/** The Creaton mark. Decorative when a name sits next to it. */
export function Mark({ size = 32, label }: { size?: number; label?: boolean }) {
  return (
    <img
      alt={label ? APP_NAME : ""}
      height={size}
      src="/assets/icons/mark.svg"
      style={{ height: size, width: "auto" }}
      width={Math.round((size * 140) / 154)}
    />
  );
}
