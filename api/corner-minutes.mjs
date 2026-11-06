// Vercel용 코너명 회의록 함수 (/api/corner-minutes)
import { handleCornerMinutes } from "../lib/corner.mjs";
import { readJson } from "../lib/chat.mjs";
export default function handler(req, res) { return handleCornerMinutes(req, res, readJson); }
