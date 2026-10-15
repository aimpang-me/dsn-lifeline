/**
 * Local craft table. spacecraftID values are negative, matching the live feed.
 * Only psyc was seen on the live feed in the recorded step 0 run. The other ids come from the
 * NAIF table or a search result and are not live-verified.
 * verified stays false until the gate records the id.
 */
export const CRAFTS = [
  { code: "eurc", name: "Europa Clipper", spacecraftID: -159, verified: false },
  { code: "psyc", name: "Psyche", spacecraftID: -255, verified: false },
  { code: "imap", name: "IMAP", spacecraftID: -43, verified: false },
  { code: "swfo", name: "SWFO-L1", spacecraftID: -231, verified: false },
];

/** @type {Map<string, (typeof CRAFTS)[number]>} */
export const CRAFT_BY_CODE = new Map(CRAFTS.map((craft) => [craft.code, craft]));

/** @type {Map<number, string>} */
export const CODE_BY_ID = new Map(CRAFTS.map((craft) => [craft.spacecraftID, craft.code]));
