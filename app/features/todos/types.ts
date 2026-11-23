import type { ComponentProps, FormEvent, ReactNode } from "react";
import type { useFetcher } from "react-router";
import type { Editable } from "~/components/editable";
import type { Attachment } from "~/concepts/attachments";
import type { ListFilters } from "~/concepts/list-filters";
import type { QuickAddVocabulary } from "~/concepts/quick-add";
import type { RelatedTodo, TodoRelations } from "~/concepts/todo-relations";
import type { ConsoleTodo, TodoUpdate } from "~/concepts/todos";
import type { Vocabulary } from "~/concepts/vocabulary";

export type Todo = ConsoleTodo & {
  updates: TodoUpdate[];
  files: Attachment[];
  relations: TodoRelations;
};
export type RowForm = ReturnType<typeof useFetcher>["Form"];
export type TodoField = (
  name: string,
) => Pick<
  ComponentProps<typeof Editable>,
  "action" | "cancelHref" | "editHref" | "editing" | "hidden" | "save"
>;

/** One card owns these values; the row and pane only render them. */
export type TodoCardView = {
  todo: Todo;
  filters: ListFilters;
  now: number;
  title: string;
  body: string;
  project: string | null;
  state: string;
  done: boolean;
  here: string;
  closed: string;
  tags: ReactNode;
  field: TodoField;
  open: string | null;
  stateForm: RowForm;
  stateAnswer: { stateId?: string; stateError?: string } | undefined;
  relationOptions: RelatedTodo[];
  tickForm: RowForm;
  sendState: (event: FormEvent<HTMLFormElement>) => void;
  blockNote: string | undefined;
  shown: string;
  vocabulary: Vocabulary & QuickAddVocabulary;
};
