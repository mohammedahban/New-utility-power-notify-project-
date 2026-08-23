// Connectivity check — verifies REAL internet reachability (not just an
// active network interface) before the app is allowed past the startup gate.
//
// The app is fully backed by Supabase, so "online" means "the backend is
// reachable". ANY HTTP response — even an error status — proves the network
// path works; only a thrown error (DNS failure, no route, timeout) counts
// as offline.
//
// Slow networks: a single fast-failing probe would false-trigger the offline
// screen on a slow-but-alive connection, so each attempt gets a generous
// 12-second budget and the check retries once before declaring offline.
const SUPABASE_HEALTH_URL =
  'https://kwlifmjwsasywjoriggn.supabase.co/auth/v1/health';

const ATTEMPT_TIMEOUT_MS = 12_000;

async function attemptOnce(timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      fetch(SUPABASE_HEALTH_URL, { method: 'GET' }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('connectivity timeout')), timeoutMs);
      }),
    ]);
    return true; // any HTTP response means the internet path works
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Returns true when the internet is genuinely reachable.
 * Two attempts (12s each) before declaring offline — cold radios and very
 * slow links often drop the first request, so a single probe is not trusted.
 */
export async function checkInternetReachable(): Promise<boolean> {
  if (await attemptOnce(ATTEMPT_TIMEOUT_MS)) return true;
  return attemptOnce(ATTEMPT_TIMEOUT_MS);
}
