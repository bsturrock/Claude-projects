import { RESOURCES, type Bundle } from "./config.js";

export const bundleValue = (b: Bundle) => RESOURCES.reduce((a, r) => a + (b[r] ?? 0), 0);
export const fmtBundle = (b: Bundle) =>
  RESOURCES.filter((r) => (b[r] ?? 0) > 0)
    .map((r) => `${b[r]} ${r}`)
    .join(", ") || "nothing";
