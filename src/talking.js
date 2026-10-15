import { CODE_BY_ID } from "./crafts.js";

const DISH = /^DSS[0-9]{2}$/;
const COMPLEXES = new Set(["Goldstone", "Canberra", "Madrid"]);

export class Talking {
  /**
   * Crafts with an active downlink. Matching uses spacecraftID only, never a target id.
   * @param {{ dishes: { name: string, station: string | null, signals: { type: string, active: boolean, spacecraftID: number | null }[] }[] }} snapshot
   * @param {{ code: string, spacecraftID: number }[]} table
   */
  static codes(snapshot, table) {
    const ids = new Map(table.map((craft) => [craft.spacecraftID, craft.code]));
    const codes = new Set();
    for (const dish of snapshot.dishes) {
      for (const signal of dish.signals) {
        if (signal.type === "downlink" && signal.active && signal.spacecraftID != null && ids.has(signal.spacecraftID)) {
          codes.add(ids.get(signal.spacecraftID));
        }
      }
    }
    return codes;
  }

  /**
   * Dish and complex from the allowlist. Feed strings that miss the list are dropped.
   * @param {import("./parser.js").Snapshot} snapshot
   */
  static locations(snapshot) {
    /** @type {Map<string, { dish: string | null, complex: string | null }>} */
    const found = new Map();
    for (const dish of snapshot.dishes) {
      for (const signal of dish.signals) {
        if (signal.type !== "downlink" || !signal.active || signal.spacecraftID == null) continue;
        const code = CODE_BY_ID.get(signal.spacecraftID);
        if (!code || found.has(code)) continue;
        found.set(code, {
          dish: DISH.test(dish.name) ? dish.name : null,
          complex: dish.station && COMPLEXES.has(dish.station) ? dish.station : null,
        });
      }
    }
    return found;
  }
}
