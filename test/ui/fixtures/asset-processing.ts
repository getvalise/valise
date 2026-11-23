import { localSql } from "./local-d1.mjs";

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

export { localSql };

export async function pendingSuggestions(baseURL: string, assetId: string) {
  const outputId = `apr_${crypto.randomUUID()}`;
  await localSql(
    baseURL,
    `INSERT INTO asset_processing
    (processing_id,user_id,asset_id,generation,processor_version,state,created_at)
    SELECT ${literal(outputId)},user_id,asset_id,
      1 + COALESCE((SELECT MAX(generation) FROM asset_processing WHERE asset_id = a.asset_id),0),
      'synthetic-ui-review','queued',unixepoch() FROM assets a WHERE asset_id=${literal(assetId)};
    INSERT INTO asset_processing_admissions(processing_id,user_id,created_at)
    SELECT processing_id,user_id,created_at FROM asset_processing WHERE processing_id=${literal(outputId)};`,
  );
  return async () => {
    const suggestions = JSON.stringify({
      title: "Synthetic orchard guide",
      summary: "Synthetic summary awaiting explicit review.",
      tags: ["synthetic-existing", "synthetic-new"],
      project: "synthetic-orchard",
    });
    await localSql(
      baseURL,
      `INSERT INTO asset_processing_outputs
      (processing_id,user_id,asset_id,object_id,original_sha256,processor_version,extractor,text,truncated,suggestions_json,suggestion_model,created_at)
      SELECT ${literal(outputId)},a.user_id,a.asset_id,a.object_id,o.sha256,
      'synthetic-ui-review','synthetic-ui-fixture','Synthetic orchard review text.',0,${literal(suggestions)},'synthetic-fixture',unixepoch()
      FROM assets a JOIN objects o ON o.object_id=a.object_id WHERE a.asset_id=${literal(assetId)};
      INSERT INTO asset_processing_heads(user_id,asset_id,processing_id)
      SELECT user_id,asset_id,processing_id FROM asset_processing WHERE processing_id=${literal(outputId)}
      ON CONFLICT(asset_id) DO UPDATE SET processing_id=excluded.processing_id;
      UPDATE asset_processing SET state='ready',finished_at=unixepoch() WHERE processing_id=${literal(outputId)};`,
    );
  };
}

/**
 * Every test in a worker signs in as one owner, so admissions from earlier
 * tests count against this one. Real processing here ends without a model
 * answer, which correctly holds a 90 s provider cooldown on the admission;
 * two of those inside 90 s fill the pending limit of 2 and refuse the next
 * Process file, depending only on which tests the worker ran just before.
 * A test that needs its own admission calls this first: it moves every
 * finished, unleased admission out of the cooldown and the rolling day.
 * Rows stay; queued, running and leased work keeps counting; the caps and
 * the refusal are unchanged.
 */
export async function isolateProcessing(baseURL: string) {
  await localSql(
    baseURL,
    `UPDATE asset_processing_admissions
    SET lease_until = 0, created_at = MIN(created_at, unixepoch() - 86401)
    WHERE lease_token IS NULL AND NOT EXISTS (SELECT 1 FROM asset_processing p
      WHERE p.processing_id = asset_processing_admissions.processing_id
        AND p.state IN ('queued', 'running'));`,
  );
}
