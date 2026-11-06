// Vercel용 코너명 회의 페이지 첨부 파일 올리기 (/api/corner-file)
import { handleCornerFile } from "../lib/corner.mjs";
import { readJson } from "../lib/chat.mjs";
export const config = { maxDuration: 60 };
export default function handler(req, res) { return handleCornerFile(req, res, readJson); }
