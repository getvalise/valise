import {
  isTodoRelationType,
  relationEdit,
  type TodoRelationEdit,
} from "~/concepts/todo-relations";

const TODO_ID = /^todo:[^:\s]+$/;

/**
 * One relation operation per form; existing set members are never reposted.
 * P2/P7. `id` is the open to-do, where the answer is shown; `subject` is the
 * to-do the coordinator edits, which for a child or a blocked dependent is the
 * other end.
 */
export function parseTodoRelationForm(form: FormData): {
  id: string;
  subject: string;
  edit: TodoRelationEdit;
} {
  const id = String(form.get("id") ?? "");
  if (!TODO_ID.test(id))
    throw new Response("Invalid to-do id.", { status: 400 });
  const operation = form.get("operation");
  if (operation === "reconcile")
    return { id, subject: id.slice(5), edit: { reconcile: true } };
  const type = form.get("type");
  const target = String(form.get("target") ?? "").trim();
  if (
    (operation !== "add" && operation !== "remove") ||
    !isTodoRelationType(type) ||
    !TODO_ID.test(target)
  )
    throw new Response("Choose a relation and a to-do.", { status: 400 });
  if (target === id)
    throw new Response("A to-do cannot relate to itself.", { status: 400 });
  const { subject, edit } = relationEdit(
    type,
    operation,
    id.slice(5),
    target.slice(5),
  );
  return { id, subject, edit };
}
