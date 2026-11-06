// Vercel용 코너명 회의 페이지 챗봇 함수 (/api/corner-chat, Claude Opus 5.5)
import { handleCornerChat } from "../lib/corner.mjs";
import { readJson } from "../lib/chat.mjs";
export const config = { maxDuration: 300 };
export default function handler(req, res) { return handleCornerChat(req, res, readJson); }
