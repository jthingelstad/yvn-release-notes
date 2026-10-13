/** Content-free deployment probe: branches before creating service clients.
 * No subscriber reads, writes, mail, secrets or models are involved. */
export function runtimeSelfTest(event: unknown): { ok: true; runtime: string; build: string } | null {
  if (
    !event ||
    typeof event !== 'object' ||
    Array.isArray(event) ||
    Object.keys(event).length !== 1 ||
    !('self_test' in event) ||
    event.self_test !== true
  )
    return null;
  return {
    ok: true,
    runtime: `Node ${process.versions.node}/${process.platform}/${process.arch}`,
    build: process.env.APP_VERSION ?? 'unknown'
  };
}
