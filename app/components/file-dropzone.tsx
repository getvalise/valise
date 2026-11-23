import { useId, useRef, useState } from "react";
import { useHydrated } from "./editable";
import { Icon } from "./icon";

/** A visible drop target, with the native multipart input before hydration. P10, P11. */
export function FileDropzone({
  label = "Choose a file",
  multiple = false,
  disabled = false,
  hint,
  onFiles,
}: {
  label?: string;
  multiple?: boolean;
  disabled?: boolean;
  hint?: string;
  /** Both the picker and a drop report the same files; the caller owns upload. */
  onFiles: (files: File[], dropped: boolean) => void;
}) {
  const hydrated = useHydrated();
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [names, setNames] = useState<string[]>([]);
  const [dropping, setDropping] = useState(false);
  const [error, setError] = useState("");
  function select(files: File[], dropped: boolean) {
    if (disabled) return;
    if (!multiple && files.length > 1) {
      setError("Choose one file at a time.");
      return;
    }
    setError("");
    setNames(files.map((file) => file.name));
    onFiles(files, dropped);
  }
  return (
    <div
      className={`file-dropzone${hydrated ? " is-enhanced" : ""}${dropping ? " is-dropping" : ""}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDropping(!disabled);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        setDropping(false);
        select(Array.from(event.dataTransfer.files), true);
      }}
    >
      <Icon name="file" size={24} />
      <p>
        <strong>Drop {multiple ? "files" : "a file"} here</strong>
      </p>
      <label className={hydrated ? "sr-only" : undefined} htmlFor={id}>
        {label}
      </label>
      <input
        aria-describedby={`${id}-hint`}
        disabled={disabled}
        id={id}
        multiple={multiple}
        name="file"
        onChange={(event) => {
          const files = (
            event.currentTarget as unknown as HTMLInputElement & {
              files: ArrayLike<File> | null;
            }
          ).files;
          select(Array.from(files ?? []), false);
        }}
        ref={input}
        required={names.length === 0}
        tabIndex={hydrated ? -1 : undefined}
        type="file"
      />
      {hydrated ? (
        <button
          className="ghost small"
          disabled={disabled}
          onClick={() =>
            (
              input.current as (HTMLInputElement & { click(): void }) | null
            )?.click()
          }
          type="button"
        >
          {multiple ? "Choose files" : "Choose a file"}
        </button>
      ) : null}
      <p className="muted" id={`${id}-hint`}>
        {hint}
      </p>
      {names.length ? <p role="status">{names.join(" · ")}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
