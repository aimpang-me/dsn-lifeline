/** Build DSN XML fixtures shaped like the public feed. Names here are test inputs, not push text. */

const STATIONS = ["Goldstone", "Canberra", "Madrid"];
const IDLE_DISHES = ["DSS14", "DSS24", "DSS25", "DSS26", "DSS34", "DSS35", "DSS36", "DSS43", "DSS54", "DSS55", "DSS56", "DSS63"];

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function signalXml(signal) {
  const dir = signal.dir === "up" ? "upSignal" : "downSignal";
  const signalType = signal.signalType ?? "none";
  const active = signal.active ?? (signalType === "data" || signalType === "carrier" ? "true" : "false");
  const spacecraftID = signal.spacecraftID ?? signal.spacecraftId ?? "-1";
  const attrs = [
    ["signalType", signalType],
    ["signalTypeDebug", signal.debug ?? "IDLE"],
    ["dataRate", signal.dataRate ?? "-1"],
    ["frequency", signal.frequency ?? "-1"],
    ["power", signal.power ?? "-1"],
    ["spacecraft", signal.spacecraft ?? "RSTS"],
    ["spacecraftID", spacecraftID],
    ["active", active],
  ];
  const text = attrs.map(([k, v]) => `${k}="${esc(v)}"`).join(" ");
  return `<${dir} ${text}/>`;
}

function dishXml(dish) {
  const targets = dish.targets ?? [{ id: "99", name: "RSTS" }];
  const signals = dish.signals ?? [
    { dir: "down", signalType: "none", debug: "IDLE", dataRate: "-1", spacecraft: "RSTS", spacecraftID: "-1", active: "false" },
    { dir: "up", signalType: "none", debug: "IDLE", dataRate: "-1", spacecraft: "RSTS", spacecraftID: "-1", active: "false" },
  ];
  const targetXml = targets
    .map((t) => `<target name="${esc(t.name ?? "RSTS")}" id="${esc(t.id)}" uplegRange="-1" downlegRange="-1" rtlt="-1"/>`)
    .join("");
  return `<dish name="${esc(dish.name)}" azimuthAngle="10" elevationAngle="20" windSpeed="0">${targetXml}${signals.map(signalXml).join("")}</dish>`;
}

/**
 * @param {{ timestamp?: number, stationCount?: number, dishCount?: number, dishes?: object[], raw?: string }} opts
 */
export function buildXml(opts = {}) {
  if (opts.raw) return opts.raw;
  const stationCount = opts.stationCount ?? 3;
  const dishCount = opts.dishCount ?? 10;
  const overlays = new Map((opts.dishes ?? []).map((d) => [d.name, d]));
  const names = IDLE_DISHES.slice(0, dishCount);
  for (const extra of opts.dishes ?? []) {
    if (!names.includes(extra.name)) names.push(extra.name);
  }
  const used = names.slice(0, Math.max(dishCount, names.length));
  const stations = STATIONS.slice(0, stationCount).map((name) => ({ name, dishes: /** @type {object[]} */ ([]) }));
  if (stations.length === 0) {
    return `<dsn><timestamp>${opts.timestamp ?? 0}</timestamp></dsn>`;
  }
  used.forEach((name, i) => {
    const station = stations[i % stations.length];
    station.dishes.push(overlays.get(name) ?? { name });
  });
  const body = stations
    .map((s) => `<station name="${esc(s.name)}" friendlyName="${esc(s.name)}">${s.dishes.map(dishXml).join("")}</station>`)
    .join("");
  return `<dsn>${body}<timestamp>${opts.timestamp ?? 0}</timestamp></dsn>`;
}

export function withTimestamp(xml, timestamp) {
  return xml.replace(/<timestamp>[^<]*<\/timestamp>/, `<timestamp>${timestamp}</timestamp>`);
}

export const INJECTED = "EvilInjectedNameZZZ";

export function swfoDown({ dataRate = "0", active = "true", spacecraftID = "-231", spacecraftId, targetId = "-999", spacecraft = "SWFO-L1", dish = "DSS14", debug = "DATA" } = {}) {
  const id = spacecraftID ?? spacecraftId ?? "-231";
  return {
    name: dish,
    targets: [{ id: targetId, name: spacecraft }],
    signals: [
      { dir: "down", signalType: "data", active, debug, dataRate, spacecraft, spacecraftID: id },
      { dir: "up", signalType: "none", active: "false", debug: "IDLE", dataRate: "-1", spacecraft, spacecraftID: id },
    ],
  };
}
