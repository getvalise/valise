import { DurableObject } from "cloudflare:workers";
import type { Provenance } from "~/concepts/memories";
import {
  type TodoCreation,
  todoCreateStatements,
} from "~/concepts/todo-create";
import {
  MAX_TODO_DEPENDENCIES,
  TODO_GRAPH_FENCE_SQL,
  TODO_GRAPH_LIMIT,
  type TodoRelationEdit,
} from "~/concepts/todo-relations";
import { updateSummary } from "~/concepts/update-summary";
import { uuid7 } from "~/lib/uuid7";
import { TodoGraphGate } from "./todo-graph-gate";

type TodoState = "pending" | "claimed" | "done" | "blocked";

type CoordinatorEnv = { DB: D1Database };

type CoordinatorTodo = {
  todoId: string;
  state: TodoState;
  leaseHolder: string | null;
  /**
   * The holder's `x-valise-session`, when its client sent one. With the
   * agent it names the holder for the paths that take no token: fetch
   * showing the token, and a re-claim returning it (ADR-0002, 2026-11-24).
   */
  holderSession: string | null;
  leaseExpiresAt: number | null;
  fencingToken: number;
  mirrorGeneration: number;
  blockedOn: string | null;
  completedAt: number | null;
  /**
   * Who held the lease when the alarm expired it, kept here only: their
   * still-current token revives it on their next write. Cleared by every
   * other transition. Absent on a row read from D1.
   */
  lapsedHolder?: string | null;
  lapsedSession?: string | null;
};

/** The lease a revival grants, the same default a claim gets. */
const DEFAULT_LEASE_SECONDS = 30 * 60;

const LOCAL_COLUMNS = `todo_id as todoId, state, lease_holder as leaseHolder,
  holder_session as holderSession, lease_expires_at as leaseExpiresAt,
  fencing_token as fencingToken, mirror_generation as mirrorGeneration,
  blocked_on as blockedOn, completed_at as completedAt,
  lapsed_holder as lapsedHolder, lapsed_session as lapsedSession`;

type TodoFailure = {
  ok: false;
  reason: string;
  holder: string | null;
  token: number | null;
};

type ClaimResult = { ok: true; token: number; expiresAt: number } | TodoFailure;

type TransitionResult =
  | { ok: true; token: number; expiresAt: number | null }
  | TodoFailure;

/**
 * One coordination atom per user. SQLite is the authority for leases and D1
 * holds the durable fencing floor plus a display/search mirror (ADR-0002).
 */
export class TodoCoordinator extends DurableObject<CoordinatorEnv> {
  // D1 awaits permit RPC interleaving. Serialize only the affected to-do so
  // a delayed successful response cannot overwrite a newer local lease.
  private readonly transitions = new Map<string, Promise<void>>();
  private readonly graph = new TodoGraphGate();

  /**
   * Whose atom this is, read off the object's name (`todos:<user_id>`), so a
   * D1 row is only ever adopted into the coordinator of the user that owns
   * it. Unnamed or malformed objects are rejected before storage is touched.
   */
  private get userId(): string {
    const name = this.ctx.id.name;
    if (!isCoordinatorName(name)) {
      throw new Error("TodoCoordinator requires a todos:<user_id> identity");
    }
    return name.slice("todos:".length);
  }

  constructor(ctx: DurableObjectState, env: CoordinatorEnv) {
    super(ctx, env);
    // Refuse invalid identities at the RPC/alarm boundary. Throwing from the
    // constructor makes the object fail initialization rather than the call.
    if (isCoordinatorName(ctx.id.name)) {
      ctx.blockConcurrencyWhile(async () => this.migrate());
    }
  }

  async claim(
    todoId: string,
    agent: string,
    ttlSeconds: number,
    sessionName: string | null = null,
    session: string | null = null,
  ): Promise<ClaimResult> {
    return this.serialize(todoId, async () => {
      const loaded = await this.load(todoId);
      if (loaded === null) return missing();
      // Reopening a done to-do can invalidate a dependent's readiness, so it
      // takes exclusive admission like the console's reopen (ADR-0018).
      const reopening = loaded.state === "done";
      return this.graph.run(reopening, async () => {
        const todo = await this.load(todoId);
        if (todo === null) return missing();
        const live = todo.state === "claimed" && !isExpired(todo, nowSeconds());
        // The holder claiming again lost its token, to a compaction or a
        // restart. It gets the same token back and a renewed lease, not a
        // refusal naming itself and a wait for its own lease to run out.
        if (live && isHolder(todo, agent, session) && !this.isUncertain(todoId))
          return this.renewLease(todo, ttlSeconds);
        const readiness = await this.dependencyFailure(todo);
        if (readiness) return readiness;
        const now = nowSeconds();
        if (todo.state === "claimed" && !isExpired(todo, now)) {
          return conflict(todo, "already claimed");
        }
        if (reopening) {
          const failure = await this.activeDependentFailure(todo);
          if (failure) return failure;
        }
        // A blocked to-do is claimable: the agent that claims it is saying its
        // blocker is resolved. A done one is too: the agent is saying the work
        // is not finished. Without this only the console could reopen either.
        const note =
          todo.state === "blocked"
            ? `resolved blocker: ${todo.blockedOn ?? "(none recorded)"}`
            : todo.state === "done"
              ? "reopened a done to-do"
              : "";

        const token = todo.fencingToken + 1;
        const expiresAt = now + ttlSeconds;
        // A reopen writes its state with the fence, as the console's does, and
        // marks the outcome uncertain until both have landed, so a lost reply
        // never leaves local `done` admitting a dependent's claim.
        if (reopening)
          this.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO uncertain_reopens (todo_id) VALUES (?)",
            todoId,
          );
        // The holder rides with the fence, so a fetch right after the claim
        // already knows whom to show the token to; the state still mirrors.
        const fence = reopening
          ? this.env.DB.prepare(
              `UPDATE todos
                SET fencing_token = ?, state = 'claimed', lease_holder = ?,
                    holder_session = ?, lease_expires_at = ?, blocked_on = NULL,
                    completed_at = NULL, updated_at = ?
              WHERE todo_id = ? AND user_id = ? AND fencing_token < ?`,
            ).bind(
              token,
              agent,
              session,
              expiresAt,
              now,
              todoId,
              this.userId,
              token,
            )
          : this.env.DB.prepare(
              `UPDATE todos
                SET fencing_token = ?, lease_holder = ?, holder_session = ?,
                    lease_expires_at = ?
              WHERE todo_id = ? AND user_id = ? AND fencing_token < ?`,
            ).bind(
              token,
              agent,
              session,
              expiresAt,
              todoId,
              this.userId,
              token,
            );
        const writes = await this.env.DB.batch([
          fence,
          this.env.DB.prepare(
            `INSERT INTO todo_updates (update_id, todo_id, kind, author, session_name, token, body, summary, created_at)
           SELECT ?, ?, 'claim', ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM todos
               WHERE todo_id = ? AND user_id = ? AND fencing_token = ?
            )`,
          ).bind(
            `tdu_${uuid7()}`,
            todoId,
            agent,
            sessionName,
            token,
            note,
            updateSummary(note),
            now,
            todoId,
            this.userId,
            token,
          ),
        ]);
        if (writes[0].meta.changes !== 1) return this.d1Conflict(todoId);

        this.queueMirror({
          todoId,
          state: "claimed",
          leaseHolder: agent,
          holderSession: session,
          leaseExpiresAt: expiresAt,
          fencingToken: token,
          mirrorGeneration: todo.mirrorGeneration + 1,
          blockedOn: null,
          completedAt: null,
          lapsedHolder: null,
          lapsedSession: null,
        });
        if (reopening)
          this.ctx.storage.sql.exec(
            "DELETE FROM uncertain_reopens WHERE todo_id = ?",
            todoId,
          );
        await this.scheduleNextAlarm();
        return { ok: true, token, expiresAt };
      });
    });
  }

  async renew(
    todoId: string,
    agent: string,
    token: number,
    ttlSeconds: number,
    session: string | null = null,
  ): Promise<TransitionResult> {
    return this.serialize(todoId, () =>
      this.graph.run(false, async () => {
        const todo = await this.requireCurrent(todoId, agent, token, session);
        if ("ok" in todo) return todo;
        return this.renewLease(todo, ttlSeconds);
      }),
    );
  }

  private async renewLease(
    todo: CoordinatorTodo,
    ttlSeconds: number,
  ): Promise<{ ok: true; token: number; expiresAt: number }> {
    const expiresAt = nowSeconds() + ttlSeconds;
    this.queueMirror({
      ...todo,
      leaseExpiresAt: expiresAt,
      mirrorGeneration: todo.mirrorGeneration + 1,
    });
    await this.scheduleNextAlarm();
    return { ok: true, token: todo.fencingToken, expiresAt };
  }

  async update(
    todoId: string,
    agent: string,
    token: number,
    body: string | null,
    renewTtlSeconds: number | null,
    sessionName: string | null = null,
    summary: string | null = null,
    session: string | null = null,
  ): Promise<TransitionResult> {
    return this.serialize(todoId, () =>
      this.graph.run(false, async () => {
        const todo = await this.requireCurrent(
          todoId,
          agent,
          token,
          session,
          sessionName,
        );
        if ("ok" in todo) return todo;
        let renewed: TransitionResult = {
          ok: true,
          token,
          expiresAt: todo.leaseExpiresAt,
        };
        if (renewTtlSeconds !== null) {
          renewed = await this.renewLease(todo, renewTtlSeconds);
          if (!renewed.ok) return renewed;
        }
        if (body === null) return renewed;

        const createdAt = nowSeconds();
        const result = await this.env.DB.prepare(
          `INSERT INTO todo_updates (update_id, todo_id, kind, author, session_name, token, body, summary, created_at)
         SELECT ?, ?, 'progress', ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM todos
             WHERE todo_id = ? AND user_id = ? AND fencing_token = ?
          )`,
        )
          .bind(
            `tdu_${uuid7()}`,
            todoId,
            agent,
            sessionName,
            token,
            body,
            updateSummary(body, summary),
            createdAt,
            todoId,
            this.userId,
            token,
          )
          .run();
        if (result.meta.changes !== 1) return this.d1Conflict(todoId);
        return renewed;
      }),
    );
  }

  async block(
    todoId: string,
    agent: string,
    token: number,
    blocker: string,
    sessionName: string | null = null,
    summary: string | null = null,
    session: string | null = null,
  ): Promise<TransitionResult> {
    return this.serialize(todoId, () =>
      this.graph.run(false, async () => {
        const todo = await this.requireCurrent(
          todoId,
          agent,
          token,
          session,
          sessionName,
        );
        if ("ok" in todo) return todo;
        const now = nowSeconds();
        const mirrored = await this.recordTransition(
          todoId,
          "blocked",
          agent,
          token,
          blocker,
          now,
          sessionName,
          summary,
        );
        if (!mirrored) return this.d1Conflict(todoId);

        this.queueMirror({
          ...todo,
          state: "blocked",
          leaseHolder: null,
          holderSession: null,
          leaseExpiresAt: null,
          mirrorGeneration: todo.mirrorGeneration + 1,
          blockedOn: blocker,
          completedAt: null,
        });
        await this.scheduleNextAlarm();
        return { ok: true, token, expiresAt: null };
      }),
    );
  }

  async complete(
    todoId: string,
    agent: string,
    token: number,
    summary: string,
    sessionName: string | null = null,
    session: string | null = null,
  ): Promise<TransitionResult> {
    return this.serialize(todoId, () =>
      this.graph.run(false, async () => {
        const todo = await this.requireCurrent(
          todoId,
          agent,
          token,
          session,
          sessionName,
        );
        if ("ok" in todo) return todo;
        const now = nowSeconds();
        const mirrored = await this.recordTransition(
          todoId,
          "complete",
          agent,
          token,
          summary,
          now,
          sessionName,
        );
        if (!mirrored) return this.d1Conflict(todoId);

        this.queueMirror({
          ...todo,
          state: "done",
          leaseHolder: null,
          holderSession: null,
          leaseExpiresAt: null,
          mirrorGeneration: todo.mirrorGeneration + 1,
          blockedOn: null,
          completedAt: now,
        });
        await this.scheduleNextAlarm();
        return { ok: true, token, expiresAt: null };
      }),
    );
  }

  /**
   * A person in the console, moving a to-do without holding its lease.
   *
   * ADR-0002 gives the lease holder exclusive *writes*; it never gave an
   * agent ownership of the ticket, and a human who cannot close a to-do an
   * agent claimed and then abandoned is waiting on a thirty-minute timer for
   * no reason. The override still goes through this object, still writes the
   * fence floor to D1 first, and still bumps the token — which is the whole
   * point. The displaced holder is not told; it finds out the next time it
   * writes, and is refused for a stale token, which is exactly the outcome
   * fencing exists to produce.
   *
   * The mirror is flushed on this path rather than queued behind the alarm,
   * because the caller is a browser that is about to re-read the list and a
   * second of display lag reads as a dead checkbox. ADR-0002 allows the
   * display mirror either way.
   */
  async override(
    todoId: string,
    actor: string,
    next: "pending" | "blocked" | "done",
    note: string,
  ): Promise<TransitionResult> {
    return this.serialize(todoId, async () => {
      const todo = await this.load(todoId);
      if (todo === null) return missing();
      return this.overrideLoaded(todo, actor, next, note);
    });
  }

  /**
   * An agent closing a to-do nobody holds, without claiming it first.
   *
   * The lease protects work in progress, so a live claim still refuses: the
   * holder completes it with its token, releases it, or lets it expire. With
   * no live claim there is no work to protect, and a claim whose only purpose
   * is to be completed one call later adds a round trip and nothing else. The
   * close is the console's override to `done` under the agent's name, so it
   * bumps the token like a re-claim, and a claim or the console reopens it.
   */
  async close(
    todoId: string,
    agent: string,
    summary: string,
    sessionName: string | null = null,
  ): Promise<TransitionResult> {
    return this.serialize(todoId, async () => {
      const todo = await this.load(todoId);
      if (todo === null) return missing();
      if (todo.state === "claimed" && !isExpired(todo, nowSeconds()))
        return conflict(
          todo,
          "already claimed; the holder completes it with its token",
        );
      if (todo.state === "done") return conflict(todo, "todo is done");
      return this.overrideLoaded(todo, agent, "done", summary, sessionName);
    });
  }

  private async overrideLoaded(
    todo: CoordinatorTodo,
    actor: string,
    next: "pending" | "blocked" | "done",
    note: string,
    sessionName: string | null = null,
  ): Promise<TransitionResult> {
    const todoId = todo.todoId;
    const uncertain = this.isUncertain(todoId);
    return this.graph.run(
      uncertain || (todo.state === "done" && next !== "done"),
      async () => {
        if (todo.state === next && !uncertain) {
          return { ok: true, token: todo.fencingToken, expiresAt: null };
        }

        if (next !== "done" && (todo.state === "done" || uncertain)) {
          if (this.graphWritePending())
            return conflict(
              todo,
              "relation write outcome unknown; reconcile relations before reopening",
            );
          const failure = await this.activeDependentFailure(todo);
          if (failure) return failure;
        }

        const now = nowSeconds();
        // An unknown D1 outcome may already have committed a higher floor. An
        // explicit console retry reconciles it; ordinary claims never guess.
        const floor = uncertain
          ? await this.env.DB.prepare(
              "SELECT fencing_token FROM todos WHERE todo_id = ? AND user_id = ?",
            )
              .bind(todoId, this.userId)
              .first<number>("fencing_token")
          : todo.fencingToken;
        if (floor === null) return missing();
        const token = Math.max(todo.fencingToken, floor) + 1;
        if (todo.state === "done" || uncertain)
          this.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO uncertain_reopens (todo_id) VALUES (?)",
            todoId,
          );
        const writes = await this.env.DB.batch([
          this.env.DB.prepare(
            `UPDATE todos
            SET fencing_token = ?, state = ?, lease_holder = NULL,
                holder_session = NULL, lease_expires_at = NULL, blocked_on = ?,
                completed_at = ?,
                updated_at = ?
          WHERE todo_id = ? AND user_id = ? AND fencing_token < ?`,
          ).bind(
            token,
            next,
            next === "blocked" ? note : null,
            next === "done" ? now : null,
            now,
            todoId,
            this.userId,
            token,
          ),
          this.env.DB.prepare(
            `INSERT INTO todo_updates (update_id, todo_id, kind, author, session_name, token, body, summary, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM todos
             WHERE todo_id = ? AND user_id = ? AND fencing_token = ?
          )`,
          ).bind(
            `tdu_${uuid7()}`,
            todoId,
            OVERRIDE_KINDS[next],
            actor,
            sessionName,
            token,
            note,
            updateSummary(note),
            now,
            todoId,
            this.userId,
            token,
          ),
        ]);
        if (writes[0].meta.changes !== 1) return this.d1Conflict(todoId);

        this.queueMirror({
          todoId,
          state: next === "done" ? "done" : next,
          leaseHolder: null,
          holderSession: null,
          leaseExpiresAt: null,
          fencingToken: token,
          mirrorGeneration: todo.mirrorGeneration + 1,
          blockedOn: next === "blocked" ? note : null,
          completedAt: next === "done" ? now : null,
          lapsedHolder: null,
          lapsedSession: null,
        });
        this.ctx.storage.sql.exec(
          "DELETE FROM uncertain_reopens WHERE todo_id = ?",
          todoId,
        );
        await this.flushMirrors();
        await this.scheduleNextAlarm();
        return { ok: true, token, expiresAt: null };
      },
    );
  }

  /** Native forms and MCP share this path; neither can race a claim or cycle check. */
  async createRelated(
    todoId: string,
    input: TodoCreation,
    provenance: Provenance,
  ): Promise<{ ok: true } | TodoFailure> {
    this.userId;
    this.migrate();
    return this.graph.run(true, async () => {
      if (this.graphWritePending()) return this.graphWriteFailure(todoId);
      const targets = [
        ...new Set([
          ...(input.depends_on ?? []),
          ...(input.parent ? [input.parent] : []),
        ]),
      ];
      if ((input.depends_on?.length ?? 0) > MAX_TODO_DEPENDENCIES)
        return {
          ...missing(),
          reason: "a to-do takes at most 20 dependencies",
        };
      for (const id of targets) {
        if (!id.startsWith("todo:") || !(await this.load(id.slice(5))))
          return { ...missing(), reason: "related to-do does not exist" };
      }
      // A fresh UUID has no incoming edges, hence neither graph can cycle.
      const committed = await this.commitGraphWrite(
        todoId,
        "create",
        (token) => {
          const writes = todoCreateStatements(
            this.env.DB,
            todoId,
            input,
            { ...provenance, userId: this.userId },
            nowSeconds(),
            token,
          );
          if (input.parent)
            writes.push(
              this.relationInsert(
                todoId,
                input.parent.slice(5),
                "parent",
                token,
              ),
            );
          for (const id of new Set(input.depends_on ?? []))
            writes.push(
              this.relationInsert(todoId, id.slice(5), "depends-on", token),
            );
          return writes;
        },
      );
      if (!committed) return this.graphWriteFailure(todoId);
      return { ok: true };
    });
  }

  async editRelations(
    todoId: string,
    edit: TodoRelationEdit,
  ): Promise<TransitionResult> {
    return this.serialize(todoId, () =>
      this.graph.run(true, async () => {
        const todo = await this.load(todoId);
        if (!todo) return missing();
        if (edit.reconcile) {
          if (
            edit.parent !== undefined ||
            edit.addDependsOn?.length ||
            edit.removeDependsOn?.length
          )
            return conflict(
              todo,
              "reconciliation cannot be combined with a relation edit",
            );
          return (await this.reconcileGraphWrite())
            ? {
                ok: true,
                token: todo.fencingToken,
                expiresAt: todo.leaseExpiresAt,
              }
            : this.graphWriteFailure(todoId);
        }
        if (this.graphWritePending()) return this.graphWriteFailure(todoId);
        if (this.isUncertain(todoId))
          return conflict(
            todo,
            "readiness unavailable; retry the console state change",
          );
        const add = [...new Set(edit.addDependsOn ?? [])];
        const remove = [...new Set(edit.removeDependsOn ?? [])];
        const endpoints = [
          ...add,
          ...remove,
          ...(edit.parent ? [edit.parent] : []),
        ];
        if (
          add.length > MAX_TODO_DEPENDENCIES ||
          remove.length > MAX_TODO_DEPENDENCIES
        )
          return conflict(todo, "at most 20 dependencies per edit");
        if (endpoints.includes(todoId))
          return conflict(todo, "a to-do cannot relate to itself");
        for (const endpoint of new Set(endpoints)) {
          if (!(await this.load(endpoint)))
            return conflict(todo, "related to-do does not exist");
        }
        const current = await this.edges(todoId, "depends-on");
        if (current.some((edge) => edge.user_id !== this.userId))
          return conflict(todo, "relations unavailable");
        const dependencies = [
          ...new Set([
            ...current
              .map((edge) => edge.to_todo_id)
              .filter((id) => !remove.includes(id)),
            ...add,
          ]),
        ];
        if (dependencies.length > MAX_TODO_DEPENDENCIES)
          return conflict(todo, "a to-do takes at most 20 dependencies");
        for (const [kind, targets] of [
          ["parent", edit.parent ? [edit.parent] : []],
          ["depends-on", add],
        ] as const) {
          for (const target of targets) {
            const failure = await this.cycleFailure(todo, target, kind);
            if (failure) return failure;
          }
        }
        if (todo.state === "claimed" && !isExpired(todo, nowSeconds())) {
          for (const dependency of dependencies) {
            const target = await this.load(dependency);
            if (
              !target ||
              target.state !== "done" ||
              this.isUncertain(dependency)
            )
              return conflict(
                todo,
                "release the active claim before adding an unfinished dependency",
              );
          }
        }
        const committed = await this.commitGraphWrite(
          todoId,
          "edit",
          (token) => {
            const writes: D1PreparedStatement[] = [];
            if (edit.parent !== undefined) {
              writes.push(
                this.env.DB.prepare(
                  `DELETE FROM todo_relations WHERE from_todo_id = ? AND user_id = ? AND kind = 'parent' AND ${TODO_GRAPH_FENCE_SQL}`,
                ).bind(todoId, this.userId, this.userId, token),
              );
              if (edit.parent)
                writes.push(
                  this.relationInsert(todoId, edit.parent, "parent", token),
                );
            }
            for (const target of remove)
              writes.push(
                this.env.DB.prepare(
                  `DELETE FROM todo_relations WHERE from_todo_id = ? AND to_todo_id = ? AND user_id = ? AND kind = 'depends-on' AND ${TODO_GRAPH_FENCE_SQL}`,
                ).bind(todoId, target, this.userId, this.userId, token),
              );
            for (const target of add)
              writes.push(
                this.relationInsert(todoId, target, "depends-on", token),
              );
            return writes;
          },
        );
        if (!committed) return this.graphWriteFailure(todoId);
        return {
          ok: true,
          token: todo.fencingToken,
          expiresAt: todo.leaseExpiresAt,
        };
      }),
    );
  }

  private relationInsert(
    from: string,
    to: string,
    kind: string,
    token: string,
  ): D1PreparedStatement {
    return this.env.DB.prepare(`INSERT OR IGNORE INTO todo_relations
      (user_id, from_todo_id, to_todo_id, kind, created_at) SELECT ?, ?, ?, ?, ? WHERE ${TODO_GRAPH_FENCE_SQL}`).bind(
      this.userId,
      from,
      to,
      kind,
      nowSeconds(),
      this.userId,
      token,
    );
  }

  private async edges(todoId: string, kind: string, inverse = false) {
    const { results } =
      await this.env.DB.prepare(`SELECT user_id, from_todo_id, to_todo_id
      FROM todo_relations WHERE ${inverse ? "user_id = ? AND to_todo_id" : "from_todo_id"} = ? AND kind = ? LIMIT ?`)
        .bind(
          ...(inverse ? [this.userId] : []),
          todoId,
          kind,
          TODO_GRAPH_LIMIT + 1,
        )
        .all<{ user_id: string; from_todo_id: string; to_todo_id: string }>();
    return results;
  }

  private async cycleFailure(
    todo: CoordinatorTodo,
    target: string,
    kind: string,
  ) {
    const { results } = await this.env.DB.prepare(`WITH RECURSIVE walk(id) AS (
      VALUES (?) UNION SELECT r.to_todo_id FROM todo_relations r JOIN walk w ON r.from_todo_id = w.id
      WHERE r.user_id = ? AND r.kind = ? LIMIT ?
    ) SELECT id FROM walk`)
      .bind(target, this.userId, kind, TODO_GRAPH_LIMIT + 1)
      .all<{ id: string }>();
    if (results.length > TODO_GRAPH_LIMIT)
      return conflict(
        todo,
        "relation traversal exceeds 256 to-dos; no change made",
      );
    return results.some((row) => row.id === todo.todoId)
      ? conflict(todo, `${kind} cycle refused`)
      : null;
  }

  private async dependencyFailure(
    todo: CoordinatorTodo,
  ): Promise<TodoFailure | null> {
    if (this.graphWritePending()) return this.graphWriteFailure(todo.todoId);
    if (this.isUncertain(todo.todoId))
      return conflict(
        todo,
        "readiness unavailable; retry the console state change",
      );
    const edges = await this.edges(todo.todoId, "depends-on");
    if (edges.length > MAX_TODO_DEPENDENCIES)
      return conflict(todo, "dependency limit exceeded; readiness unavailable");
    for (const edge of edges) {
      const target =
        edge.user_id === this.userId ? await this.load(edge.to_todo_id) : null;
      if (!target || this.isUncertain(edge.to_todo_id))
        return conflict(todo, "dependency readiness unavailable");
      if (target.state !== "done")
        return conflict(
          todo,
          "unfinished dependencies; fetch the to-do's relations",
        );
    }
    return null;
  }

  private async activeDependentFailure(
    todo: CoordinatorTodo,
  ): Promise<TodoFailure | null> {
    const edges = await this.edges(todo.todoId, "depends-on", true);
    if (edges.length > TODO_GRAPH_LIMIT)
      return conflict(
        todo,
        "dependent traversal exceeds 256 to-dos; reopen refused",
      );
    for (const edge of edges) {
      const dependent =
        edge.user_id === this.userId
          ? await this.load(edge.from_todo_id)
          : null;
      if (!dependent || this.isUncertain(edge.from_todo_id))
        return conflict(todo, "dependent readiness unavailable");
      if (dependent.state === "claimed" && !isExpired(dependent, nowSeconds()))
        return conflict(
          todo,
          "release or complete active dependent claims before reopening this prerequisite",
        );
    }
    return null;
  }

  private isUncertain(todoId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec("SELECT todo_id FROM uncertain_reopens WHERE todo_id = ?", todoId)
        .toArray().length > 0
    );
  }

  private graphWritePending() {
    return (
      this.ctx.storage.sql
        .exec<{ token: string; todoId: string; kind: string }>(
          "SELECT token, todo_id AS todoId, kind FROM uncertain_graph_write WHERE singleton_id = 1",
        )
        .toArray()[0] ?? null
    );
  }

  private graphWriteFailure(todoId: string): TodoFailure {
    const pending = this.graphWritePending();
    return {
      ...missing(),
      reason: `relation write outcome unknown for todo:${pending?.todoId ?? todoId}; reconcile relations, inspect the result, then retry if needed`,
    };
  }

  /** The marker precedes both awaits; a rejected response never proves cancellation. */
  private async commitGraphWrite(
    todoId: string,
    kind: "create" | "edit",
    statements: (token: string) => D1PreparedStatement[],
  ): Promise<boolean> {
    const token = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO uncertain_graph_write (singleton_id, token, todo_id, kind) VALUES (1, ?, ?, ?)",
      token,
      todoId,
      kind,
    );
    try {
      await this.reserveGraphFence(token);
      const results = await this.env.DB.batch<{ token: string }>([
        ...statements(token),
        this.env.DB.prepare(
          "SELECT token FROM todo_relation_fences WHERE user_id = ?",
        ).bind(this.userId),
      ]);
      if (results.some((result) => !result.success)) return false;
      if (results[results.length - 1].results[0]?.token !== token) return false;
      this.ctx.storage.sql.exec(
        "DELETE FROM uncertain_graph_write WHERE singleton_id = 1 AND token = ?",
        token,
      );
      return true;
    } catch {
      return false;
    }
  }

  private reserveGraphFence(token: string) {
    return this.env.DB.prepare(`INSERT INTO todo_relation_fences (user_id, token) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET token = excluded.token`)
      .bind(this.userId, token)
      .run();
  }

  /** Fence, do not replay. Every possible original mutation checks its old token in its transaction. */
  private async reconcileGraphWrite(): Promise<boolean> {
    const pending = this.graphWritePending();
    if (!pending) return true;
    try {
      await this.reserveGraphFence(crypto.randomUUID());
      this.ctx.storage.sql.exec(
        "DELETE FROM uncertain_graph_write WHERE singleton_id = 1 AND token = ?",
        pending.token,
      );
      return true;
    } catch {
      return false;
    }
  }

  async release(
    todoId: string,
    agent: string,
    token: number,
    sessionName: string | null = null,
    session: string | null = null,
  ): Promise<TransitionResult> {
    return this.serialize(todoId, () =>
      this.graph.run(false, async () => {
        const todo = await this.requireCurrent(
          todoId,
          agent,
          token,
          session,
          sessionName,
        );
        if ("ok" in todo) return todo;
        const released = await this.releaseClaim(
          todoId,
          agent,
          token,
          "released",
          sessionName,
        );
        // Without this the mirror waited for the alarm still set at the old
        // expiry, and listings showed a released to-do claimed until then.
        await this.scheduleNextAlarm();
        return released;
      }),
    );
  }

  async alarm(): Promise<void> {
    this.userId;
    await this.flushMirrors();
    const now = nowSeconds();
    const expired = this.ctx.storage.sql
      .exec<CoordinatorTodo>(
        `SELECT ${LOCAL_COLUMNS}
           FROM coordinator_todos
          WHERE state = 'claimed' AND lease_expires_at <= ?`,
        now,
      )
      .toArray();
    for (const todo of expired) {
      await this.serialize(todo.todoId, async () => {
        // The scan predates waiting for an in-flight transition. A renewal,
        // re-claim or override may already have replaced this expired lease.
        const current = this.read(todo.todoId);
        if (current?.state !== "claimed" || !isExpired(current, nowSeconds()))
          return;
        await this.releaseClaim(
          current.todoId,
          current.leaseHolder ?? "system",
          current.fencingToken,
          "lease expired",
          null,
          true,
        );
      });
    }
    await this.flushMirrors();
    await this.scheduleNextAlarm();
  }

  async resetForDevelopment(): Promise<void> {
    this.userId;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  private async serialize<T>(
    todoId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.transitions.get(todoId);
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.transitions.set(todoId, pending);
    await previous;
    try {
      return await operation();
    } finally {
      // The queue tail always resolves, even when the operation fails.
      release();
      if (this.transitions.get(todoId) === pending)
        this.transitions.delete(todoId);
    }
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS uncertain_graph_write (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), token TEXT NOT NULL, todo_id TEXT NOT NULL, kind TEXT NOT NULL
    )`);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS uncertain_reopens (todo_id TEXT PRIMARY KEY)",
    );
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_todos (
        todo_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        lease_holder TEXT,
        lease_expires_at INTEGER,
        fencing_token INTEGER NOT NULL,
        mirror_generation INTEGER NOT NULL,
        blocked_on TEXT,
        completed_at INTEGER
      )
    `);
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(coordinator_todos)")
      .toArray()
      .map((column) => column.name);
    if (!columns.includes("mirror_generation")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE coordinator_todos ADD COLUMN mirror_generation INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!columns.includes("blocked_on")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE coordinator_todos ADD COLUMN blocked_on TEXT",
      );
    }
    if (!columns.includes("completed_at")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE coordinator_todos ADD COLUMN completed_at INTEGER",
      );
    }
    for (const column of ["holder_session", "lapsed_holder", "lapsed_session"])
      if (!columns.includes(column))
        this.ctx.storage.sql.exec(
          `ALTER TABLE coordinator_todos ADD COLUMN ${column} TEXT`,
        );
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mirror_queue (
        todo_id TEXT PRIMARY KEY,
        mirror_generation INTEGER NOT NULL
      )
    `);
  }

  private async load(todoId: string): Promise<CoordinatorTodo | null> {
    const userId = this.userId;
    let stored: CoordinatorTodo | null;
    try {
      stored = this.read(todoId);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("no such table")
      ) {
        throw error;
      }
      this.migrate();
      stored = this.read(todoId);
    }
    // D1 owns identity, not the live lease. Check even a cached row so a
    // restore cannot leave this atom coordinating another user's to-do.
    const source = await this.env.DB.prepare(
      `SELECT todo_id as todoId, state, lease_holder as leaseHolder,
                holder_session as holderSession,
                lease_expires_at as leaseExpiresAt, fencing_token as fencingToken,
                mirror_generation as mirrorGeneration, blocked_on as blockedOn,
                completed_at as completedAt
           FROM todos WHERE todo_id = ? AND user_id = ?`,
    )
      .bind(todoId, userId)
      .first<CoordinatorTodo>();
    if (source === null) {
      this.forget(todoId);
      return null;
    }
    // Another RPC can advance the lease while the ownership read is in flight.
    stored = this.read(todoId);
    if (stored !== null) return stored;
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO coordinator_todos
        (todo_id, state, lease_holder, holder_session, lease_expires_at,
         fencing_token, mirror_generation, blocked_on, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source.todoId,
      source.state,
      source.leaseHolder,
      source.holderSession,
      source.leaseExpiresAt,
      source.fencingToken,
      source.mirrorGeneration,
      source.blockedOn,
      source.completedAt,
    );
    return this.read(todoId);
  }

  private read(todoId: string): CoordinatorTodo | null {
    return (
      this.ctx.storage.sql
        .exec<CoordinatorTodo>(
          `SELECT ${LOCAL_COLUMNS} FROM coordinator_todos WHERE todo_id = ?`,
          todoId,
        )
        .toArray()[0] ?? null
    );
  }

  private forget(todoId: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM uncertain_reopens WHERE todo_id = ?",
      todoId,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM mirror_queue WHERE todo_id = ?",
      todoId,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM coordinator_todos WHERE todo_id = ?",
      todoId,
    );
  }

  private write(todo: CoordinatorTodo): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO coordinator_todos
        (todo_id, state, lease_holder, holder_session, lease_expires_at,
         fencing_token, mirror_generation, blocked_on, completed_at,
         lapsed_holder, lapsed_session)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      todo.todoId,
      todo.state,
      todo.leaseHolder,
      todo.holderSession,
      todo.leaseExpiresAt,
      todo.fencingToken,
      todo.mirrorGeneration,
      todo.blockedOn,
      todo.completedAt,
      todo.lapsedHolder ?? null,
      todo.lapsedSession ?? null,
    );
  }

  /**
   * The lease a guarded write may use: the caller's token must be current and
   * the caller the agent it was issued to. A lease that expired while nobody
   * claimed over it is still that holder's, because its token is: the write
   * revives it rather than being refused for a token nothing superseded.
   */
  private async requireCurrent(
    todoId: string,
    agent: string,
    token: number,
    session: string | null = null,
    sessionName: string | null = null,
  ): Promise<CoordinatorTodo | TransitionResult> {
    const todo = await this.load(todoId);
    if (todo === null) return missing();
    if (this.isUncertain(todoId))
      return conflict(
        todo,
        "readiness unavailable; retry the console state change",
      );
    if (todo.fencingToken !== token)
      return conflict(todo, "stale fencing token");
    if (todo.state === "claimed" && todo.leaseHolder === agent) {
      if (!isExpired(todo, nowSeconds())) return todo;
      return this.revive(
        todo,
        agent,
        session ?? todo.holderSession,
        sessionName,
      );
    }
    if (todo.state === "pending" && todo.lapsedHolder === agent)
      return this.revive(
        todo,
        agent,
        session ?? todo.lapsedSession ?? null,
        sessionName,
      );
    return conflict(todo, "stale fencing token");
  }

  /**
   * Re-grants an expired lease to the holder whose token is still current.
   * Nobody claimed in between, or the token would have moved, so nothing is
   * lost: the holder carries on and the log says the lease came back. It is
   * a claim in all but the token, so structured prerequisites still apply.
   */
  private async revive(
    todo: CoordinatorTodo,
    agent: string,
    session: string | null,
    sessionName: string | null,
  ): Promise<CoordinatorTodo | TransitionResult> {
    const readiness = await this.dependencyFailure(todo);
    if (readiness) return readiness;
    const now = nowSeconds();
    const expiresAt = now + DEFAULT_LEASE_SECONDS;
    const note = "revived its expired lease";
    const writes = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE todos
            SET lease_holder = ?, holder_session = ?, lease_expires_at = ?
          WHERE todo_id = ? AND user_id = ? AND fencing_token = ?`,
      ).bind(
        agent,
        session,
        expiresAt,
        todo.todoId,
        this.userId,
        todo.fencingToken,
      ),
      this.env.DB.prepare(
        `INSERT INTO todo_updates (update_id, todo_id, kind, author, session_name, token, body, summary, created_at)
         SELECT ?, ?, 'claim', ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM todos
             WHERE todo_id = ? AND user_id = ? AND fencing_token = ?
          )`,
      ).bind(
        `tdu_${uuid7()}`,
        todo.todoId,
        agent,
        sessionName,
        todo.fencingToken,
        note,
        updateSummary(note),
        now,
        todo.todoId,
        this.userId,
        todo.fencingToken,
      ),
    ]);
    if (writes[1].meta.changes !== 1) return this.d1Conflict(todo.todoId);
    const revived: CoordinatorTodo = {
      ...todo,
      state: "claimed",
      leaseHolder: agent,
      holderSession: session,
      leaseExpiresAt: expiresAt,
      mirrorGeneration: todo.mirrorGeneration + 1,
      blockedOn: null,
      completedAt: null,
      lapsedHolder: null,
      lapsedSession: null,
    };
    this.queueMirror(revived);
    await this.scheduleNextAlarm();
    return revived;
  }

  private async releaseClaim(
    todoId: string,
    agent: string,
    token: number,
    reason: string,
    sessionName: string | null = null,
    /** An expiry, not a hand-back: the holder's token may revive it. */
    lapse = false,
  ): Promise<TransitionResult> {
    const todo = this.read(todoId);
    if (todo === null) return missing();
    const now = nowSeconds();
    const mirrored = await this.recordTransition(
      todoId,
      "release",
      agent,
      token,
      reason,
      now,
      sessionName,
    );
    if (!mirrored) return this.d1Conflict(todoId);

    this.queueMirror({
      ...todo,
      state: "pending",
      leaseHolder: null,
      holderSession: null,
      leaseExpiresAt: null,
      mirrorGeneration: todo.mirrorGeneration + 1,
      blockedOn: null,
      completedAt: null,
      lapsedHolder: lapse ? todo.leaseHolder : null,
      lapsedSession: lapse ? todo.holderSession : null,
    });
    return { ok: true, token, expiresAt: null };
  }

  private async recordTransition(
    todoId: string,
    kind: "blocked" | "complete" | "release",
    author: string,
    token: number,
    body: string,
    createdAt: number,
    sessionName: string | null = null,
    summary: string | null = null,
  ): Promise<boolean> {
    const result = await this.env.DB.prepare(
      `INSERT INTO todo_updates (update_id, todo_id, kind, author, session_name, token, body, summary, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM todos WHERE todo_id = ? AND user_id = ? AND fencing_token = ?
        )`,
    )
      .bind(
        `tdu_${uuid7()}`,
        todoId,
        kind,
        author,
        sessionName,
        token,
        body,
        updateSummary(body, summary),
        createdAt,
        todoId,
        this.userId,
        token,
      )
      .run();
    return result.meta.changes === 1;
  }

  private queueMirror(todo: CoordinatorTodo): void {
    this.write(todo);
    this.ctx.storage.sql.exec(
      `INSERT INTO mirror_queue (todo_id, mirror_generation)
       VALUES (?, ?)
       ON CONFLICT(todo_id) DO UPDATE SET mirror_generation = excluded.mirror_generation`,
      todo.todoId,
      todo.mirrorGeneration,
    );
  }

  private async flushMirrors(): Promise<void> {
    const queued = this.ctx.storage.sql
      .exec<{ todoId: string; mirrorGeneration: number }>(
        `SELECT todo_id as todoId, mirror_generation as mirrorGeneration
           FROM mirror_queue`,
      )
      .toArray();
    for (const queuedTodo of queued) {
      const todo = this.read(queuedTodo.todoId);
      if (todo === null) {
        this.ctx.storage.sql.exec(
          "DELETE FROM mirror_queue WHERE todo_id = ?",
          queuedTodo.todoId,
        );
        continue;
      }
      const updatedAt = nowSeconds();
      const result = await this.env.DB.prepare(
        `UPDATE todos
            SET state = ?, lease_holder = ?, holder_session = ?,
                lease_expires_at = ?, blocked_on = ?, completed_at = ?,
                updated_at = ?, mirror_generation = ?
          WHERE todo_id = ? AND user_id = ? AND fencing_token = ? AND mirror_generation < ?`,
      )
        .bind(
          todo.state,
          todo.leaseHolder,
          todo.holderSession,
          todo.leaseExpiresAt,
          todo.blockedOn,
          todo.completedAt,
          updatedAt,
          todo.mirrorGeneration,
          todo.todoId,
          this.userId,
          todo.fencingToken,
          todo.mirrorGeneration,
        )
        .run();
      if (result.meta.changes !== 1) {
        // Discard missing/foreign cached rows rather than retrying their
        // mirrors forever. Owned rows retain the usual fence/retry behavior.
        await this.load(todo.todoId);
        continue;
      }
      this.ctx.storage.sql.exec(
        `DELETE FROM mirror_queue
          WHERE todo_id = ? AND mirror_generation = ?`,
        queuedTodo.todoId,
        queuedTodo.mirrorGeneration,
      );
    }
  }

  private async d1Conflict(todoId: string): Promise<TodoFailure> {
    const current = await this.load(todoId);
    return current === null
      ? missing()
      : conflict(current, "stale fencing token");
  }

  private async scheduleNextAlarm(): Promise<void> {
    const nextLease = this.ctx.storage.sql
      .exec<{ leaseExpiresAt: number }>(
        `SELECT MIN(lease_expires_at) as leaseExpiresAt
           FROM coordinator_todos
          WHERE state = 'claimed'`,
      )
      .toArray()[0];
    const hasMirror = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) as count FROM mirror_queue")
      .toArray()[0]?.count;
    const retryAt = hasMirror ? Date.now() + 1000 : undefined;
    const leaseAt = nextLease?.leaseExpiresAt
      ? nextLease.leaseExpiresAt * 1000
      : undefined;
    const next = [retryAt, leaseAt]
      .filter((value): value is number => value !== undefined)
      .reduce<number | undefined>(
        (earliest, value) =>
          earliest === undefined ? value : Math.min(earliest, value),
        undefined,
      );
    if (next === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }
}

/** What the progress log calls a console override, in its existing vocabulary. */
const OVERRIDE_KINDS = {
  pending: "release",
  blocked: "blocked",
  done: "complete",
} as const;

function isCoordinatorName(name: string | undefined): name is string {
  return (
    name !== undefined &&
    name.startsWith("todos:") &&
    name.length > "todos:".length &&
    !/[\s:]/.test(name.slice("todos:".length))
  );
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The holder, for the paths that take no token: its agent, and its session
 * when the claim recorded one. A claim from a client that sends no session
 * keys on the agent alone, as every lease did before 2026-11-24.
 */
function isHolder(
  todo: CoordinatorTodo,
  agent: string,
  session: string | null,
): boolean {
  return (
    todo.leaseHolder === agent &&
    (todo.holderSession === null || todo.holderSession === session)
  );
}

function isExpired(todo: CoordinatorTodo, now: number): boolean {
  return todo.leaseExpiresAt !== null && todo.leaseExpiresAt <= now;
}

function conflict(todo: CoordinatorTodo, reason: string): TodoFailure {
  return {
    ok: false,
    reason,
    holder: todo.leaseHolder,
    token: todo.fencingToken,
  };
}

function missing(): TodoFailure {
  return {
    ok: false,
    reason: "todo does not exist",
    holder: null,
    token: null,
  };
}
