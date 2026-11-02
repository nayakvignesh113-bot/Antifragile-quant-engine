// Credit-rating reader. pg_cron calls this every 10 minutes (header x-afqe-token).
// Takes companies whose latest rating link (from Screener's documents section) is new or stale, reads the
// rationale (ICRA serves PDFs, CRISIL/CARE HTML), parses it with core.js and stores it in afqe.ratings.
// Deploy with verify_jwt = false (token checked in Postgres).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { DOMParser } from "npm:linkedom@0.18.5";
import { extractText, getDocumentProxy } from "npm:unpdf@0.12.1";
import * as core from "https://raw.githubusercontent.com/nayakvignesh113-bot/Antifragile-quant-engine/982fa34b455872ba7b82c79ee4beabdab594892b/supabase/functions/afqe-parse/core.js";
(globalThis as any).DOMParser = DOMParser;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const ALLOWED = /^https:\/\/(www\.)?(icra\.in|crisil\.com|careratings\.com|careedge\.in|indiaratings\.co\.in)\//;
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

async function readText(u: string): Promise<string> {
  let url = u.replace(/ /g, "%20");
  const icra = url.match(/icra\.in\/Rationale\/ShowRationaleReport\/?\?Id=(\d+)/i);
  if (icra) url = "https://www.icra.in/Rating/GetRationalReportFilePdf?Id=" + icra[1];
  if (!ALLOWED.test(url)) throw new Error("host not allowed");
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 25000);
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ctl.signal }).finally(() => clearTimeout(tm));
  if (!r.ok) throw new Error("HTTP " + r.status);
  const buf = new Uint8Array(await r.arrayBuffer());
  const isPdf = (r.headers.get("content-type") || "").includes("pdf") || (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46);
  if (isPdf) { const pdf = await getDocumentProxy(buf); const t = await extractText(pdf, { mergePages: true }); return String(t.text || ""); }
  const html = new TextDecoder().decode(buf);
  return html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&amp;|&#39;|&quot;/g, " ").replace(/\s+/g, " ");
}

Deno.serve(async (req) => {
  const token = req.headers.get("x-afqe-token") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: queue, error } = await sb.rpc("afqe_rating_queue", { token, lim: 10 });
  if (error) return json({ error: error.message }, 500);
  if (!Array.isArray(queue)) return json(queue, 401);
  const items: any[] = [];
  for (const it of queue) {
    const one = async (l: any) => { if (!l || !l.u) return null; const t = await readText(String(l.u)); const p = core.parseRating(t, String(l.u), String(l.w || "")); return p && p.grade ? p : { ...p, grade: "" }; };
    try {
      const latest = await one(it.l0);
      let prev = null; try { prev = await one(it.l1); if (prev) prev = { u: prev.u, agency: prev.agency, grade: prev.grade, outlook: prev.outlook, action: prev.action, date: prev.date }; } catch (_) { prev = null; }
      items.push({ symbol: it.symbol, latest: latest && latest.grade ? latest : null, prev, err: latest && latest.grade ? null : "no grade found" });
    } catch (e) { items.push({ symbol: it.symbol, latest: null, prev: null, err: String((e as Error)?.message || e).slice(0, 200) }); }
  }
  if (!items.length) return json({ done: 0 });
  const { data: st, error: e2 } = await sb.rpc("afqe_rating_store", { token, items });
  if (e2) return json({ error: e2.message }, 500);
  return json({ done: items.length, ok: items.filter((x) => x.latest).length, stored: st });
});
