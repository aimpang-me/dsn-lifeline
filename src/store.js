export class Sql {
  /** @param {string} table @param {string} key @param {string[]} cols */
  static upsert(table, key, cols) {
    const names = [key, ...cols];
    const marks = names.map(() => "?").join(", ");
    const sets = cols.map((col) => `${col} = excluded.${col}`).join(", ");
    return `INSERT INTO ${table} (${names.join(", ")}) VALUES (${marks}) ON CONFLICT(${key}) DO UPDATE SET ${sets}`;
  }
}

export class Store {
  /**
   * @param {{ sql: { exec: (q: string, ...a: unknown[]) => { toArray: () => Record<string, unknown>[] } } }} storage
   * @param {{ charge: () => void }} budget
   */
  constructor(storage, budget) {
    this.storage = storage;
    this.budget = budget;
  }

  /** @param {string} sql @param {...unknown} args */
  read(sql, ...args) {
    return this.storage.sql.exec(sql, ...args).toArray();
  }

  /** @param {string} sql @param {...unknown} args */
  write(sql, ...args) {
    const rows = this.storage.sql.exec(sql, ...args).toArray();
    this.budget.charge();
    return rows;
  }
}
