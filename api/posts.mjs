// Vercel용 게시글 함수 (/api/posts)
import { handlePosts } from "../lib/store.mjs";
import { readJson } from "../lib/chat.mjs";
export default function handler(req, res) { return handlePosts(req, res, readJson); }
