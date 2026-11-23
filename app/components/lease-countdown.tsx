import { useEffect, useState } from "react";

type LeaseCountdownProps = {
  expiresAt: number | null;
  initialSeconds: number;
};

export function LeaseCountdown({
  expiresAt,
  initialSeconds,
}: LeaseCountdownProps) {
  const [seconds, setSeconds] = useState(initialSeconds);

  useEffect(() => {
    if (expiresAt === null) return;
    const update = () => {
      setSeconds(Math.max(0, expiresAt - Math.floor(Date.now() / 1000)));
    };
    update();
    const interval = globalThis.setInterval(update, 1_000);
    return () => globalThis.clearInterval(interval);
  }, [expiresAt]);

  if (expiresAt === null) return <>No active lease</>;
  if (seconds === 0) return <>Lease expiry pending sync</>;
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return (
    <>
      {minutes}:{remainder} remaining
    </>
  );
}
