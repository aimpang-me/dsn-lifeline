/**
 * @param {string} nodeVersion
 * @param {() => { DatabaseSync?: unknown }} loadSqlite
 */
export function checkRuntime(nodeVersion, loadSqlite) {
  const major = Number(String(nodeVersion).split(".")[0]);
  if (!Number.isFinite(major) || major < 22) {
    throw new Error(`DSN Lifeline needs Node.js 22 or newer. This process is Node.js ${nodeVersion}.`);
  }
  try {
    const sqlite = loadSqlite();
    if (typeof sqlite?.DatabaseSync !== "function") throw new Error("DatabaseSync missing");
    return sqlite;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("DSN Lifeline needs Node.js")) throw err;
    throw new Error(`DSN Lifeline needs node:sqlite, which Node.js ${nodeVersion} does not provide.`);
  }
}
