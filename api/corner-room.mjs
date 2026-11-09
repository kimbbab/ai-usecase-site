// Vercel용 코너명 회의 "함께 채팅" (/api/corner-room): 참가자 + @클로드·@엑사원
import { handleRoom } from "../lib/room.mjs";
import { readJson } from "../lib/chat.mjs";
export const config = { maxDuration: 300 };
export default function handler(req, res) { return handleRoom(req, res, readJson); }
