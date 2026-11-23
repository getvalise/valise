import { z } from "zod";
import { SUBJECT_KINDS } from "~/concepts/memory-subjects";

function valid<T>(result: z.ZodSafeParseResult<T>): T {
  if (result.success) return result.data;
  throw new Response(
    result.error.issues.map((issue) => issue.message).join(" "),
    { status: 400 },
  );
}

const name = z.string().trim().min(1).max(200);
const description = z.string().trim().max(1000);
const subjectId = z.string().regex(/^sub_[0-9a-f-]{36}$/);
const memoryId = z.string().regex(/^memory:[^:\s]+$/);

export function parseSubjectCreate(form: FormData) {
  return valid(
    z.object({ name, kind: z.enum(SUBJECT_KINDS), description }).safeParse({
      name: form.get("name"),
      kind: form.get("kind"),
      description: form.get("description") ?? "",
    }),
  );
}

export function parseSubjectAction(form: FormData) {
  return valid(
    z
      .discriminatedUnion("intent", [
        z.object({
          intent: z.literal("edit"),
          id: subjectId,
          field: z.enum(["name", "kind", "description"]),
          value: z.string().max(1000),
        }),
        z.object({
          intent: z.literal("member"),
          id: subjectId,
          action: z.enum(["add", "remove"]),
          memory: memoryId,
        }),
        z.object({
          intent: z.literal("summary"),
          id: subjectId,
          memory: z.union([memoryId, z.literal("")]),
        }),
        z.object({
          intent: z.literal("delete"),
          id: subjectId,
          deleted: z.enum(["true", "false"]),
        }),
        z.object({
          intent: z.literal("new-summary"),
          id: subjectId,
          body: z
            .string()
            .trim()
            .min(1)
            .max(16 * 1024),
        }),
      ])
      .safeParse(Object.fromEntries(form)),
  );
}

export function validateSubjectField(
  field: "name" | "kind" | "description",
  value: string,
) {
  return valid(
    (field === "name"
      ? name
      : field === "kind"
        ? z.enum(SUBJECT_KINDS)
        : description
    ).safeParse(value),
  );
}
