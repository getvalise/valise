import type { ComponentProps } from "react";
import { cn } from "~/lib/utils";

/**
 * A boolean setting, drawn as shadcn's Switch. It stays a native button with
 * the switch role, so a console setting still posts without scripts (P11);
 * the stable label names the setting, and aria-checked announces its state.
 */
export function BeltSwitch({
  label,
  checked,
  hideLabel = false,
  type = "button",
  className,
  ...props
}: Omit<ComponentProps<"button">, "children" | "role" | "aria-checked"> & {
  label: string;
  checked: boolean;
  /** In a list row the row names the setting; the label is for readers. */
  hideLabel?: boolean;
  /** Retired: the clasp and stud drawings are one switch now. */
  variant?: "clasp" | "stud";
}) {
  const { variant: _retired, ...button } = props as typeof props & {
    variant?: string;
  };
  return (
    <button
      {...button}
      aria-checked={checked}
      className={cn(
        "belt-switch group/switch inline-flex min-h-[24px] cursor-pointer items-center gap-2 text-sm text-foreground disabled:cursor-not-allowed disabled:text-muted-foreground",
        className,
      )}
      data-slot="switch-button"
      data-state={checked ? "checked" : "unchecked"}
      role="switch"
      type={type}
    >
      <span
        aria-hidden="true"
        className="belt-strap inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent bg-input shadow-xs transition-colors group-data-[state=checked]/switch:bg-primary group-disabled/switch:bg-muted! group-disabled/switch:ring-1 group-disabled/switch:ring-input group-focus-visible/switch:ring-[3px] group-focus-visible/switch:ring-ring/50"
      >
        <span className="belt-hardware pointer-events-none block size-4 translate-x-0 rounded-full bg-background ring-0 transition-transform group-data-[state=checked]/switch:translate-x-[calc(100%-2px)] motion-reduce:transition-none" />
      </span>
      <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
    </button>
  );
}
