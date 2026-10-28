export async function poll<T>(
  what: string,
  read: () => Promise<T | undefined>,
  { everyMs = Number(process.env.WORKSHOP_POLL_MS ?? 15_000), timeoutMs = 60 * 60_000 } = {},
): Promise<T> {
  const start = Date.now();
  const secs = () => Math.round((Date.now() - start) / 1000);
  for (;;) {
    let value: T | undefined;
    try {
      value = await read();
    } catch (e) {
      console.log(`${what}: read failed at ${secs()}s, retrying (${String(e).split("\n")[0]?.slice(0, 120)})`);
    }
    if (value !== undefined) {
      console.log(`${what}: found after ${secs()}s`);
      return value;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`${what}: none after ${timeoutMs / 60_000} min`);
    console.log(`${what}: not yet (${secs()}s), next check in ${everyMs / 1000}s`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
