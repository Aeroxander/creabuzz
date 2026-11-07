import { useForecastRecord } from "../use-forecasts";

/**
 * A person's forecasting record on their profile (N3): how accurate their forecasts on settled bounties were, beside how
 * many settled, computed in this browser from their public forecasts and the chain. Nothing for someone who never
 * forecast. No ranking: it is shown for one person at a time.
 */
export function ForecastRecordLine({ pubkey }: { pubkey: string }) {
  const record = useForecastRecord(pubkey);
  const data = record.data;
  if (!data || data.forecasts === 0) return null;
  return (
    <p
      className="mt-2 text-sm text-black/70 dark:text-white/70"
      data-testid="profile-forecasts"
    >
      {data.score === null
        ? `Forecasts on ${data.forecasts === 1 ? "1 bounty" : `${data.forecasts} bounties`}, none settled yet.`
        : `Forecasts: ${data.score} out of 100 over ${data.settled === 1 ? "1 settled bounty" : `${data.settled} settled bounties`}. Always saying 50% would score 75.`}
    </p>
  );
}
