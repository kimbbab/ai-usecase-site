// Vercel용: AX 뉴스 목록 (/api/news)
import { handleNews } from "../lib/news.mjs";
export default function handler(req, res) { return handleNews(req, res); }
