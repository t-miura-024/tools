import { PERSPECTIVE_POOL } from "./perspective-pool.ts";

export const VALID_AXIS_IDS = new Set<string>(PERSPECTIVE_POOL.map((p) => p.id));
