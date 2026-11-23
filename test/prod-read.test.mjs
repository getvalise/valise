import assert from "node:assert/strict";
import { test } from "node:test";
import { readOnlySql } from "../scripts/prod-read.mjs";

test("accepts one SELECT or WITH read", () => {
  for (const sql of [
    "SELECT count(*) AS n FROM memories",
    "select 1;",
    "WITH t AS (SELECT 1 AS x) SELECT x FROM t",
    "SELECT updated_at, replace(title, 'a', 'b') FROM todos",
    "SELECT 'DELETE FROM users; --' AS s",
    'SELECT "delete" FROM t',
  ])
    assert.equal(readOnlySql(sql), sql.trim());
});

test("refuses writes, second statements and hiding places", () => {
  for (const sql of [
    "",
    "DELETE FROM users",
    "SELECT 1; DELETE FROM users",
    "SELECT 1;;",
    "WITH t AS (SELECT 1) DELETE FROM users",
    "WITH t AS (SELECT 1) UPDATE users SET email='x'",
    "WITH t AS (SELECT 1) REPLACE INTO users SELECT * FROM t",
    "WITH t AS (SELECT 1) INSERT INTO users SELECT * FROM t",
    "PRAGMA table_list",
    "SELECT 1 -- ; DROP TABLE users",
    "SELECT 1 /* ; */",
    "SELECT 'unterminated",
    "ATTACH 'x' AS y",
    "VACUUM",
  ])
    assert.throws(() => readOnlySql(sql), undefined, sql);
});
