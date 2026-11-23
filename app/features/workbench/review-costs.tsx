import { Form } from "react-router";
import { Card, Empty, Pill } from "~/components/ui";
import {
  type AccountReviewCost,
  CAP_MAX_MICROUSD,
  CAP_MIN_MICROUSD,
  DEFAULT_RANKING_MICROUSD,
  DEFAULT_REVIEW_MICROUSD,
} from "~/concepts/memory-review-limits";

const usd = (microusd: number) => `$${(microusd / 1_000_000).toFixed(4)}`;
const dollars = (microusd: number) => String(microusd / 1_000_000);

/**
 * What memory review may cost each account a day (ADR-0012, 2026-11-04
 * limits). People choose how many memories get checked; the money caps are an
 * operator's, enforced in the same SQL statements that reserve each call.
 */
export function ReviewCosts({
  accounts,
  saved,
  refused,
}: {
  accounts: AccountReviewCost[];
  saved: string | null;
  refused: { userId: string; message: string } | null;
}) {
  return (
    <section aria-label="Memory review costs" className="grid gap-3">
      <h2 className="eyebrow">Memory review caps</h2>
      <p className="muted">
        Daily money caps on memory review and candidate ranking, per account.
        Without a cap set here an account gets {usd(DEFAULT_REVIEW_MICROUSD)}{" "}
        for review and {usd(DEFAULT_RANKING_MICROUSD)} for ranking. Each cap is{" "}
        {usd(CAP_MIN_MICROUSD)} to {usd(CAP_MAX_MICROUSD)}, resets at midnight
        UTC, and counts reservations made before each call, failures included.
      </p>
      {accounts.length === 0 ? (
        <Empty>No accounts.</Empty>
      ) : (
        <ul className="card-list">
          {accounts.map((account) => {
            const name = account.displayName || account.email || account.userId;
            return (
              <Card as="li" className="todo-card" key={account.userId}>
                <Pill tone={account.setBy ? "done" : "label"}>
                  {account.setBy ? "set by an admin" : "default"}
                </Pill>
                <h3 id={`caps-${account.userId}`}>{name}</h3>
                <p className="muted">
                  Today: review {usd(account.reviewSpent)} of{" "}
                  {usd(account.reviewMicrousd)}, ranking{" "}
                  {usd(account.rankingSpent)} of {usd(account.rankingMicrousd)}.
                </p>
                <Form
                  aria-label={`Cost caps for ${name}`}
                  action="/workbench?tab=costs"
                  className="row flex-wrap items-end"
                  method="post"
                  preventScrollReset
                >
                  <input name="intent" type="hidden" value="review-caps" />
                  <input name="user" type="hidden" value={account.userId} />
                  <input
                    name="wasReview"
                    type="hidden"
                    value={account.reviewMicrousd}
                  />
                  <input
                    name="wasRanking"
                    type="hidden"
                    value={account.rankingMicrousd}
                  />
                  <label className="field min-w-0">
                    Review cap (USD a day)
                    <input
                      defaultValue={dollars(account.reviewMicrousd)}
                      max={CAP_MAX_MICROUSD / 1_000_000}
                      min={CAP_MIN_MICROUSD / 1_000_000}
                      name="reviewUsd"
                      required
                      step="0.000001"
                      type="number"
                    />
                  </label>
                  <label className="field min-w-0">
                    Ranking cap (USD a day)
                    <input
                      defaultValue={dollars(account.rankingMicrousd)}
                      max={CAP_MAX_MICROUSD / 1_000_000}
                      min={CAP_MIN_MICROUSD / 1_000_000}
                      name="rankingUsd"
                      required
                      step="0.000001"
                      type="number"
                    />
                  </label>
                  <button className="ghost" type="submit">
                    Save caps
                  </button>
                </Form>
                {saved === account.userId ? <p role="status">Saved.</p> : null}
                {refused?.userId === account.userId ? (
                  <p role="alert">{refused.message}</p>
                ) : null}
              </Card>
            );
          })}
        </ul>
      )}
    </section>
  );
}
