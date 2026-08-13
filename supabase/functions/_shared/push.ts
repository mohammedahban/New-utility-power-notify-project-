/**
 * _shared/push.ts — Expo push delivery helper with ticket hygiene.
 *
 * Why: pushes were previously fire-and-forget. The send API returns a ticket
 * per message; "DeviceNotRegistered" tickets mean the token is dead (app
 * uninstalled / token rotated) and keeping it poisons every future send
 * (and, for the admin, hid the fact that ALL of his tokens were stale).
 * Now every send parses tickets, logs them, and deletes dead tokens so the
 * next device registration starts clean.
 */

export interface PushTicketResult {
  sent: number;
  ok: number;
  deadTokens: string[];
  errors: Array<{ token: string; error: string; message?: string }>;
  raw: unknown;
}

export async function sendExpoPush(
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  messages: Array<Record<string, unknown> & { to: string }>,
  tag: string,
): Promise<PushTicketResult> {
  const result: PushTicketResult = { sent: 0, ok: 0, deadTokens: [], errors: [], raw: null };
  if (messages.length === 0) return result;

  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate',
    },
    body: JSON.stringify(messages),
  });
  const json = await res.json().catch(() => null);
  result.raw = json;
  result.sent = messages.length;

  const tickets: Array<{ status?: string; details?: { error?: string; message?: string } }> =
    Array.isArray(json?.data) ? json.data : [];

  tickets.forEach((ticket, i) => {
    const token = messages[i]?.to ?? '';
    if (ticket?.status === 'ok') {
      result.ok++;
      return;
    }
    const errCode = ticket?.details?.error ?? 'Unknown';
    const errMsg = ticket?.details?.message;
    result.errors.push({ token, error: errCode, message: errMsg });
    console.warn(`[${tag}] push ticket error for ...${token.slice(-8)}: ${errCode}${errMsg ? ' — ' + errMsg : ''}`);
    if (errCode === 'DeviceNotRegistered') {
      result.deadTokens.push(token);
    }
  });

  console.log(`[${tag}] push summary: ${result.ok}/${result.sent} ok, ${result.deadTokens.length} dead token(s)`);

  // Hygiene: dead tokens will never deliver again — remove them so they stop
  // polluting every future send and so a fresh install re-registers cleanly.
  if (result.deadTokens.length > 0) {
    const { error } = await supabaseAdmin
      .from('push_tokens')
      .delete()
      .in('token', result.deadTokens);
    if (error) console.warn(`[${tag}] failed to delete dead tokens:`, error.message);
    else console.log(`[${tag}] deleted ${result.deadTokens.length} dead token(s)`);
  }

  return result;
}
