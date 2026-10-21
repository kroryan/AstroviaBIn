/** Whether the server now runs a different AstroviaBin version than this page (an update while it was open). */
export async function serverVersionChanged(): Promise<boolean> {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) return false;
    const { version } = await response.json() as { version?: string };
    return Boolean(version) && version !== __APP_VERSION__;
  } catch {
    return false;
  }
}
