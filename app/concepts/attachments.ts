import { insertObject, putObject, readObject } from "~/r2/objects";

/**
 * Concept-owned file links. The bytes and their owner are `app/r2/objects.ts`;
 * storage never learns which concept points at an object. ADR-0011.
 */

export type Attachment = {
  objectId: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: number;
};

export type AttachmentTarget = { concept: "todo" | "memory"; id: string };

// Identifiers come only from this closed mapping, never from request input.
function linkTables(concept: AttachmentTarget["concept"]) {
  return concept === "todo"
    ? { table: "todo_attachments", parent: "todos", id: "todo_id", active: "" }
    : {
        table: "memory_attachments",
        parent: "memories",
        id: "memory_id",
        active: " AND deleted_at IS NULL",
      };
}

/**
 * Stores the file and links it to the to-do in one batch. Null when the to-do
 * does not exist, checked before any bytes reach R2.
 */
export async function attachTodoFile(
  env: { DB: D1Database; BUNDLES: R2Bucket },
  userId: string,
  todoId: string,
  file: File,
): Promise<Attachment | null> {
  return attachFile(env, userId, { concept: "todo", id: todoId }, file);
}

export async function attachMemoryFile(
  env: { DB: D1Database; BUNDLES: R2Bucket },
  userId: string,
  memoryId: string,
  file: File,
): Promise<Attachment | null> {
  return attachFile(env, userId, { concept: "memory", id: memoryId }, file);
}

async function attachFile(
  env: { DB: D1Database; BUNDLES: R2Bucket },
  userId: string,
  target: AttachmentTarget,
  file: File,
): Promise<Attachment | null> {
  const { table, parent, id, active } = linkTables(target.concept);
  const exists = await env.DB.prepare(
    `SELECT 1 FROM ${parent} WHERE ${id} = ? AND user_id = ?${active}`,
  )
    .bind(target.id, userId)
    .first();
  if (exists === null) return null;
  const stored = await putObject(env.BUNDLES, userId, file);
  await env.DB.batch([
    insertObject(env.DB, stored),
    env.DB.prepare(
      `INSERT INTO ${table} (${id}, object_id, created_at) VALUES (?, ?, ?)`,
    ).bind(target.id, stored.objectId, stored.createdAt),
  ]);
  return {
    objectId: stored.objectId,
    name: stored.name,
    contentType: stored.contentType,
    size: stored.size,
    createdAt: stored.createdAt,
  };
}

/** Every listed to-do's files in one query, keyed by bare to-do id. */
export async function listTodoAttachments(
  db: D1Database,
  userId: string,
  todoIds: string[],
): Promise<Map<string, Attachment[]>> {
  return listAttachments(db, userId, "todo", todoIds);
}

export async function listMemoryAttachments(
  db: D1Database,
  userId: string,
  memoryIds: string[],
): Promise<Map<string, Attachment[]>> {
  return listAttachments(db, userId, "memory", memoryIds);
}

async function listAttachments(
  db: D1Database,
  userId: string,
  concept: AttachmentTarget["concept"],
  ids: string[],
): Promise<Map<string, Attachment[]>> {
  const byTarget = new Map<string, Attachment[]>();
  if (ids.length === 0) return byTarget;
  const { table, parent, id, active } = linkTables(concept);
  const { results } = await db
    .prepare(
      `SELECT a.${id} AS targetId, o.object_id AS objectId, o.name,
              o.content_type AS contentType, o.size, a.created_at AS createdAt
         FROM ${table} a
         JOIN objects o ON o.object_id = a.object_id
         JOIN ${parent} p ON p.${id} = a.${id}
        WHERE o.user_id = ?
          AND p.user_id = o.user_id${active}
           AND a.${id} IN (SELECT value FROM json_each(?))
        ORDER BY a.created_at, o.object_id`,
    )
    .bind(userId, JSON.stringify(ids))
    .all<Attachment & { targetId: string }>();
  for (const { targetId, ...attachment } of results) {
    const list = byTarget.get(targetId) ?? [];
    list.push(attachment);
    byTarget.set(targetId, list);
  }
  return byTarget;
}

/** Changes only the concept's link. An owner's bytes and row are retained. */
export async function setFileAttached(
  db: D1Database,
  userId: string,
  target: AttachmentTarget,
  objectId: string,
  attached: boolean,
): Promise<boolean> {
  const { table, parent, id, active } = linkTables(target.concept);
  const ownedTarget = await db
    .prepare(
      `SELECT 1 FROM objects o WHERE o.object_id = ? AND o.user_id = ?
       AND EXISTS (SELECT 1 FROM ${parent} WHERE ${id} = ? AND user_id = o.user_id${active})`,
    )
    .bind(objectId, userId, target.id)
    .first();
  if (ownedTarget === null) return false;
  if (attached) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO ${table} (${id}, object_id, created_at)
       SELECT ?, object_id, created_at FROM objects
        WHERE object_id = ? AND user_id = ?
          AND EXISTS (SELECT 1 FROM ${parent} WHERE ${id} = ? AND user_id = objects.user_id${active})`,
      )
      .bind(target.id, objectId, userId, target.id)
      .run();
  } else {
    await db
      .prepare(
        `DELETE FROM ${table} WHERE ${id} = ? AND object_id = ?
          AND object_id IN (SELECT object_id FROM objects WHERE user_id = ?)
          AND EXISTS (SELECT 1 FROM ${parent} p WHERE p.${id} = ${table}.${id}
            AND p.user_id = (SELECT user_id FROM objects WHERE object_id = ${table}.object_id)${active})`,
      )
      .bind(target.id, objectId, userId)
      .run();
  }
  return true;
}

/**
 * One attached file's stored object, only while its parent is live and owned
 * and the file is still linked to it. These checks precede R2; a URI never
 * carries a key.
 */
export async function readAttachedObject(
  env: { DB: D1Database; BUNDLES: R2Bucket },
  userId: string,
  target: AttachmentTarget,
  objectId: string,
) {
  const active = await env.DB.prepare(
    target.concept === "memory"
      ? "SELECT 1 FROM memories WHERE memory_id = ? AND user_id = ? AND deleted_at IS NULL"
      : "SELECT 1 FROM todos WHERE todo_id = ? AND user_id = ?",
  )
    .bind(target.id, userId)
    .first();
  if (active === null) return null;
  const listed =
    target.concept === "todo"
      ? await listTodoAttachments(env.DB, userId, [target.id])
      : await listMemoryAttachments(env.DB, userId, [target.id]);
  if (!(listed.get(target.id) ?? []).some((file) => file.objectId === objectId))
    return null;
  return readObject(env, userId, objectId);
}
