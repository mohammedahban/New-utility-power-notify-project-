-- APPPE v6: record how far ahead each logged prediction looked.
-- Lets accuracy analysis separate short-horizon (next slot) error from
-- long-horizon (tomorrow's schedule) error, so the model can be tuned
-- against the horizon that actually matters for user trust.
ALTER TABLE public.prediction_accuracy_logs
  ADD COLUMN IF NOT EXISTS horizon_minutes integer;

COMMENT ON COLUMN public.prediction_accuracy_logs.horizon_minutes IS
  'Minutes between prediction_generated_at and the actual event. Set by analyze-patterns v6+.';
