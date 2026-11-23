import { type ReactNode, useId } from "react";
import { Form } from "react-router";
import { Icon } from "~/components/icon";

export function SearchField({
  label,
  name,
  defaultValue,
  placeholder,
  type = "search",
  hideLabel = false,
  value,
  onValueChange,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  type?: "search" | "url";
  hideLabel?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
}) {
  const id = useId();
  return (
    <label className="field search-field" htmlFor={id}>
      <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
      <input
        id={id}
        name={name}
        type={type}
        defaultValue={defaultValue}
        value={value}
        onChange={
          onValueChange
            ? (event) => onValueChange(event.currentTarget.value)
            : undefined
        }
        placeholder={placeholder}
      />
    </label>
  );
}

export function SearchBar({
  action,
  field,
  hidden,
  submit = "Search",
  children,
}: {
  action: string;
  field: Parameters<typeof SearchField>[0];
  hidden: [string, string][];
  submit?: string;
  children?: ReactNode;
}) {
  return (
    <Form
      action={action}
      className="search-bar flex min-w-0 flex-1 flex-wrap items-end gap-2 [&>button]:gap-1.5 [&_input]:min-w-0"
      method="get"
    >
      {hidden.map(([name, value], index) => (
        <input
          key={`${name}:${index}`}
          name={name}
          type="hidden"
          value={value}
        />
      ))}
      <SearchField {...field} />
      <button className="ghost" type="submit">
        <Icon name="search" />
        {submit}
      </button>
      {children}
    </Form>
  );
}
