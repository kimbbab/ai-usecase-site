// Vercel용: 매일 아침 예약 실행으로 뉴스 모으기 (/api/news-refresh)
import { handleNewsRefresh } from "../lib/news.mjs";
export const config = { maxDuration: 60 };
export default function handler(req, res) { return handleNewsRefresh(req, res); }
