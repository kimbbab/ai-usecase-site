// Vercel용 챗봇 함수 (/api/chat)
import { handleChat } from "../lib/chat.mjs";
export const config = { maxDuration: 60 };
export default function handler(req, res) { return handleChat(req, res); }
