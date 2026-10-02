import "dotenv/config";
import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";
import cookieParser from "cookie-parser";
import { ensureBotTables, enqueueJob, startWorker, heartbeat } from "./lib/bots.js";
import { ensureAuthTables, attachAuthRoutes, requireAuth } from "./lib/auth.js";
import { attachAgentApi } from "./lib/agentApi.js";

const BOT_NAME = "dumadot";

const { Pool } = pg;
const app = express();
const PORT = Number(process.env.PORT || 3000);
const TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata";
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
fs.mkdirSync("public/uploads", { recursive: true });

const dbUrl = process.env.DATABASE_URL || "";
const isLocalDb = /localhost|127\.0\.0\.1/.test(dbUrl);
const useSsl = !!dbUrl && !isLocalDb && process.env.PGSSLMODE !== "disable";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSsl ? { rejectUnauthorized: false } : false });

// Auth routes (login/claim/logout/me) must be reachable before the gate;
// everything registered after requireAuth - the dashboard's static files
// included - requires a logged-in session. req.user.id is what scopes every
// route below to that person's own data.
app.get("/api/health",(req,res)=>res.json({ok:true,app:"Dumadot",version:"3.0.0",time:new Date().toISOString()}));
attachAuthRoutes(app, pool, { appName: "Dumadot" });
// Dobydot (personal-assistant agent) drives drafting/publishing through this
// key-protected surface; it must sit before the login wall. It reuses the
// same createDraft/publishPost the dashboard buttons call.
attachAgentApi(app, pool, {
  name: "Duma",
  draft: async (user, p) => {
    const topic = [p.topic || "", p.instructions ? `Revision notes from the author - apply them: ${p.instructions}` : "", p.previous ? `Previous draft being revised:\n${p.previous}` : ""].filter(Boolean).join("\n\n");
    const d = await createDraft(user.id, topic);
    return { handle: String(d.id), title: d.topic, body: d.content, notes: `Pillar: ${d.pillar || "-"} · quality ${d.quality?.score ?? "?"}/100` };
  },
  publish: async (user, handle) => {
    await markApproved(user.id, Number(handle));
    await publishPost(user.id, Number(handle));
    return { summary: "Posted to LinkedIn." };
  },
  discard: async (user, handle) => {
    await dbRun("DELETE FROM posts WHERE id=? AND user_id=? AND status!='published'", [Number(handle), user.id]);
    return { ok: true };
  },
});
app.use(requireAuth(pool));
// no-cache (not no-store) on the HTML shell: the browser still revalidates
// via ETag and gets a fast 304 when nothing changed, but a real deploy is
// never masked by a stale cached copy of the dashboard.
app.use(express.static("public", { setHeaders: (res, filePath) => { if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache"); } }));

function nowStamp() { return new Date().toISOString().slice(0, 19).replace("T", " "); }
function toPg(sql) { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); }
async function dbAll(sql, params = []) { const r = await pool.query(toPg(sql), params); return r.rows; }
async function dbGet(sql, params = []) { const rows = await dbAll(sql, params); return rows[0]; }
async function dbRun(sql, params = []) { return pool.query(toPg(sql), params); }

async function columnExists(table, column) {
  return !!(await dbGet("SELECT 1 FROM information_schema.columns WHERE table_name=? AND column_name=?", [table, column]));
}
async function addColumn(table, column, type) {
  if (!(await columnExists(table, column))) await dbRun(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

const safePillars = "Performance Marketing,AdTech,Affiliate Marketing,App Marketing & Growth,Industry Insights,Digirovers Insights";
const DEFAULT_SETTINGS = {
  content_pillars: process.env.CONTENT_PILLARS || safePillars,
  post_time: process.env.POST_TIME || "10:30",
  auto_publish: process.env.AUTO_PUBLISH || "false",
  research_enabled: "true",
  voice_instructions: "Human, sharp, practical, commercially aware. Use strong hooks, short paragraphs and specific observations. Avoid corporate fluff, fake statistics, generic motivation, excessive emojis and AI-sounding phrasing.",
  planner_guidance: "",
  research_last_run: "",
  // Free-text: who you are and what your business does. Blank by default -
  // each person fills this in for themselves in Settings; nothing is
  // assumed on their behalf.
  business_context: "",
};

async function initDb() {
  await ensureAuthTables(pool);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      scheduled_for TEXT,
      linkedin_post_id TEXT,
      created_at TEXT NOT NULL,
      published_at TEXT
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id INTEGER PRIMARY KEY CHECK (id = 1), access_token TEXT NOT NULL, refresh_token TEXT,
      expires_at BIGINT, person_urn TEXT, name TEXT, email TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS linkedin_connections (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at BIGINT,
      person_urn TEXT,
      name TEXT,
      email TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ideas (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      pillar TEXT,
      notes TEXT,
      source_url TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'idea',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS research_items (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT,
      url TEXT NOT NULL UNIQUE,
      source TEXT,
      relevance INTEGER DEFAULT 0,
      discovered_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS research_usage (
      user_id INTEGER NOT NULL REFERENCES users(id),
      research_item_id INTEGER NOT NULL REFERENCES research_items(id) ON DELETE CASCADE,
      used_at TEXT NOT NULL,
      PRIMARY KEY (user_id, research_item_id)
    );
    CREATE TABLE IF NOT EXISTS content_plans (
      id SERIAL PRIMARY KEY,
      plan_date TEXT NOT NULL,
      pillar TEXT NOT NULL,
      topic TEXT NOT NULL,
      format TEXT NOT NULL,
      rationale TEXT,
      status TEXT NOT NULL DEFAULT 'idea',
      post_id INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS post_metrics (
      post_id INTEGER PRIMARY KEY,
      impressions INTEGER DEFAULT 0,
      reactions INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      reposts INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS voice_examples (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduler_runs (
      run_date TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS calendar_events (
      id SERIAL PRIMARY KEY,
      event_date TEXT NOT NULL,
      name TEXT NOT NULL,
      notes TEXT,
      recurring_yearly INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);

  await addColumn("posts", "pillar", "TEXT");
  await addColumn("posts", "format", "TEXT");
  await addColumn("posts", "quality_score", "INTEGER");
  await addColumn("posts", "quality_notes", "TEXT");
  await addColumn("posts", "source_url", "TEXT");
  await addColumn("posts", "research_context", "TEXT");
  await addColumn("posts", "approved_at", "TEXT");
  await addColumn("posts", "updated_at", "TEXT");
  await addColumn("posts", "image_path", "TEXT");

  // --- Multi-tenant migration (idempotent - safe to run on every boot) ---
  await addColumn("posts", "user_id", "INTEGER REFERENCES users(id)");
  await addColumn("ideas", "user_id", "INTEGER REFERENCES users(id)");
  await addColumn("voice_examples", "user_id", "INTEGER REFERENCES users(id)");
  await addColumn("content_plans", "user_id", "INTEGER REFERENCES users(id)");
  await addColumn("scheduler_runs", "user_id", "INTEGER REFERENCES users(id)");
  await addColumn("settings", "user_id", "INTEGER REFERENCES users(id)");

  // The old table definitions above gave these columns single-column
  // uniqueness (a plain PK or UNIQUE) - which only made sense when there was
  // one implicit owner. Drop those and replace with per-user uniqueness so
  // two different users can each have their own "post_time" setting, their
  // own content plan for the same calendar date, etc. Postgres's default
  // constraint-naming convention is relied on here (<table>_pkey for an
  // inline PRIMARY KEY, <table>_<column>_key for an inline UNIQUE) - both
  // deterministic since neither was ever given an explicit name.
  await pool.query(`ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS settings_user_key_idx ON settings(user_id,key)`);
  await pool.query(`ALTER TABLE content_plans DROP CONSTRAINT IF EXISTS content_plans_plan_date_key`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS content_plans_user_date_idx ON content_plans(user_id,plan_date)`);
  await pool.query(`ALTER TABLE scheduler_runs DROP CONSTRAINT IF EXISTS scheduler_runs_pkey`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS scheduler_runs_user_date_idx ON scheduler_runs(user_id,run_date)`);

  // Backfill: anything created before this migration had no owner. Assign it
  // all to the first admin account so nothing appears to vanish for whoever
  // was using Dumadot before multi-user support existed.
  const firstAdmin = await dbGet("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");
  if (firstAdmin) {
    await dbRun("UPDATE posts SET user_id=? WHERE user_id IS NULL", [firstAdmin.id]);
    await dbRun("UPDATE ideas SET user_id=? WHERE user_id IS NULL", [firstAdmin.id]);
    await dbRun("UPDATE voice_examples SET user_id=? WHERE user_id IS NULL", [firstAdmin.id]);
    await dbRun("UPDATE content_plans SET user_id=? WHERE user_id IS NULL", [firstAdmin.id]);
    await dbRun("UPDATE settings SET user_id=? WHERE user_id IS NULL", [firstAdmin.id]);
    const oldToken = await dbGet("SELECT * FROM oauth_tokens WHERE id=1");
    if (oldToken) {
      await dbRun(
        `INSERT INTO linkedin_connections(user_id,access_token,refresh_token,expires_at,person_urn,name,email,created_at)
         VALUES(?,?,?,?,?,?,?,?) ON CONFLICT (user_id) DO NOTHING`,
        [firstAdmin.id, oldToken.access_token, oldToken.refresh_token, oldToken.expires_at, oldToken.person_urn, oldToken.name, oldToken.email, oldToken.created_at]
      );
    }
  }

  if (!(await dbGet("SELECT 1 FROM calendar_events LIMIT 1"))) {
    const thisYear = new Date().getFullYear();
    const seedEvent = (date, name, notes) => dbRun("INSERT INTO calendar_events(event_date,name,notes,recurring_yearly,created_at) VALUES(?,?,?,1,?)", [date, name, notes, nowStamp()]);
    await seedEvent(`${thisYear}-01-01`, "New Year's Day", "Global");
    await seedEvent(`${thisYear}-01-26`, "Republic Day", "India");
    await seedEvent(`${thisYear}-08-15`, "Independence Day", "India");
    await seedEvent(`${thisYear}-10-02`, "Gandhi Jayanti", "India");
    await seedEvent(`${thisYear}-12-25`, "Christmas", "Global");
  }

  await ensureBotTables(pool);
}

async function setting(userId, key) {
  const row = await dbGet("SELECT value FROM settings WHERE user_id=? AND key=?", [userId, key]);
  return row ? row.value : DEFAULT_SETTINGS[key];
}
async function updateSetting(userId, key, value) {
  await dbRun("INSERT INTO settings(user_id,key,value) VALUES(?,?,?) ON CONFLICT (user_id,key) DO UPDATE SET value=excluded.value", [userId, key, String(value)]);
}
async function pillars(userId) { const raw = (await setting(userId, "content_pillars")) || safePillars; return raw.split(",").map(x => x.trim()).filter(Boolean).filter(p => !/cps\s*\/\s*cpl|cps|cpl/i.test(p)); }
function baseUrl() { return process.env.APP_BASE_URL || `http://localhost:${PORT}`; }
async function tokenRow(userId) { return dbGet("SELECT * FROM linkedin_connections WHERE user_id=?", [userId]); }
async function recentTopics(userId, limit = 30) { return (await dbAll("SELECT topic FROM posts WHERE user_id=? ORDER BY id DESC LIMIT ?", [userId, limit])).map(x => x.topic); }
async function recentContent(userId, limit = 20) { return dbAll("SELECT id,topic,content FROM posts WHERE user_id=? ORDER BY id DESC LIMIT ?", [userId, limit]); }
function nowLocalParts() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23" }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t)?.value;
  return { date:`${get("year")}-${get("month")}-${get("day")}`, hour:Number(get("hour")), minute:Number(get("minute")) };
}
function dayOffset(n) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + n);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year:"numeric", month:"2-digit", day:"2-digit" }).format(d);
}
function isExcluded(text) { return /\bcps\b|\bcpl\b/i.test(String(text || "")); }
function isPlannerExcluded(text) { return /\bcps\b|\bcpl\b/i.test(String(text || "")); }

async function eventsForDate(dateStr) {
  const md = dateStr.slice(5);
  return dbAll("SELECT * FROM calendar_events WHERE event_date=? OR (recurring_yearly=1 AND substr(event_date,6,5)=?)", [dateStr, md]);
}
async function eventsInRange(fromStr, toStr) {
  const rows = await dbAll("SELECT * FROM calendar_events");
  const from = new Date(fromStr), to = new Date(toStr);
  const out = [];
  for (const r of rows) {
    if (r.recurring_yearly) {
      const [, mm, dd] = r.event_date.split("-");
      for (let y = from.getFullYear(); y <= to.getFullYear(); y++) {
        const d = new Date(`${y}-${mm}-${dd}`);
        if (d >= from && d <= to) out.push({ ...r, event_date: `${y}-${mm}-${dd}` });
      }
    } else {
      const d = new Date(r.event_date);
      if (d >= from && d <= to) out.push(r);
    }
  }
  return out.sort((a, b) => a.event_date.localeCompare(b.event_date));
}
function localHourWeekday(utcTimestamp) {
  if (!utcTimestamp) return null;
  const d = new Date(utcTimestamp.replace(" ", "T") + (utcTimestamp.includes("Z") ? "" : "Z"));
  if (isNaN(d)) return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, hour: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(d);
  const hour = Number(parts.find(p => p.type === "hour")?.value);
  const weekday = parts.find(p => p.type === "weekday")?.value;
  return { hour, weekday };
}

function linkedinAuthUrl() {
  const params = new URLSearchParams({ response_type:"code", client_id:process.env.LINKEDIN_CLIENT_ID, redirect_uri:process.env.LINKEDIN_REDIRECT_URI || `${baseUrl()}/auth/linkedin/callback`, scope:"openid profile email w_member_social", state:crypto.randomBytes(24).toString("hex") });
  globalThis.oauthState = params.get("state");
  return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
}
async function linkedinToken(userId, code) {
  const body = new URLSearchParams({ grant_type:"authorization_code", code, client_id:process.env.LINKEDIN_CLIENT_ID, client_secret:process.env.LINKEDIN_CLIENT_SECRET, redirect_uri:process.env.LINKEDIN_REDIRECT_URI || `${baseUrl()}/auth/linkedin/callback` });
  const r = await fetch("https://www.linkedin.com/oauth/v2/accessToken", { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body });
  const data = await r.json(); if (!r.ok) throw new Error(data.error_description || JSON.stringify(data));
  const profileR = await fetch("https://api.linkedin.com/v2/userinfo", { headers:{Authorization:`Bearer ${data.access_token}`} });
  const profile = await profileR.json(); if (!profileR.ok) throw new Error(JSON.stringify(profile));
  const personUrn = `urn:li:person:${profile.sub}`;
  await dbRun(`INSERT INTO linkedin_connections(user_id,access_token,refresh_token,expires_at,person_urn,name,email,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT (user_id) DO UPDATE SET access_token=excluded.access_token,refresh_token=excluded.refresh_token,expires_at=excluded.expires_at,person_urn=excluded.person_urn,name=excluded.name,email=excluded.email`,
    [userId, data.access_token, data.refresh_token||null, data.expires_in?Date.now()+data.expires_in*1000:null, personUrn, profile.name||`${profile.given_name||""} ${profile.family_name||""}`.trim(), profile.email||null, nowStamp()]);
  return profile;
}
async function uploadLinkedInImage(accessToken, personUrn, imagePath) {
  const linkedinVersion = process.env.LINKEDIN_VERSION||"202603";
  const initR = await fetch("https://api.linkedin.com/rest/images?action=initializeUpload", { method:"POST", headers:{Authorization:`Bearer ${accessToken}`,"Content-Type":"application/json","X-Restli-Protocol-Version":"2.0.0","Linkedin-Version":linkedinVersion}, body: JSON.stringify({ initializeUploadRequest: { owner: personUrn } }) });
  const initData = await initR.json(); if (!initR.ok) throw new Error(`LinkedIn image init ${initR.status}: ${JSON.stringify(initData)}`);
  const uploadUrl = initData.value.uploadUrl;
  const imageUrn = initData.value.image;
  const fileBuf = fs.readFileSync(`public${imagePath}`);
  const upR = await fetch(uploadUrl, { method:"PUT", headers:{Authorization:`Bearer ${accessToken}`}, body: fileBuf });
  if (!upR.ok) throw new Error(`LinkedIn image upload failed: ${upR.status}`);
  return imageUrn;
}
async function publishToLinkedIn(userId, content, imagePath) {
  const token = await tokenRow(userId); if (!token) throw new Error("LinkedIn is not connected.");
  const payload = { author:token.person_urn, commentary:content, visibility:"PUBLIC", distribution:{feedDistribution:"MAIN_FEED",targetEntities:[],thirdPartyDistributionChannels:[]}, lifecycleState:"PUBLISHED", isReshareDisabledByAuthor:false };
  if (imagePath) {
    const imageUrn = await uploadLinkedInImage(token.access_token, token.person_urn, imagePath);
    payload.content = { media: { id: imageUrn } };
  }
  const r = await fetch("https://api.linkedin.com/rest/posts", { method:"POST", headers:{Authorization:`Bearer ${token.access_token}`,"Content-Type":"application/json","X-Restli-Protocol-Version":"2.0.0","Linkedin-Version":process.env.LINKEDIN_VERSION||"202603"}, body:JSON.stringify(payload) });
  const text = await r.text(); if (!r.ok) throw new Error(`LinkedIn ${r.status}: ${text}`); return r.headers.get("x-restli-id") || text;
}

async function fetchRssItems(url) {
  const r=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36","Accept":"application/rss+xml, text/xml, */*"},signal:AbortSignal.timeout(12000)});
  if(!r.ok) throw new Error(`RSS ${r.status}`);
  const xml=await r.text();
  const decode=s=>s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  const rawBlocks=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  const items=rawBlocks.map(m=>{const b=m[1];const get=t=>decode((b.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${t}>`,'i'))||[])[1]||'').trim();return {title:get('title'),link:get('link'),description:get('description')};}).filter(x=>x.title&&x.link);
  if(!items.length){
    const itemTagCount=(xml.match(/<item>/gi)||[]).length;
    const firstBlock=rawBlocks[0]?rawBlocks[0][1].slice(0,400):"(no block matched by <item>...</item>)";
    throw new Error(`RSS returned 0 usable items (raw <item> tags: ${itemTagCount}, matchAll blocks: ${rawBlocks.length}, first block: ${firstBlock.replace(/\s+/g,' ')})`);
  }
  return items;
}
const FEEDS = [
  ["Google Ads", "https://news.google.com/rss/search?q=Google%20Ads%20marketing&hl=en-IN&gl=IN&ceid=IN:en"],
  ["Meta Ads", "https://news.google.com/rss/search?q=Meta%20Ads%20advertising&hl=en-IN&gl=IN&ceid=IN:en"],
  ["AdTech", "https://news.google.com/rss/search?q=adtech%20programmatic%20advertising&hl=en-IN&gl=IN&ceid=IN:en"],
  ["Affiliate Marketing", "https://news.google.com/rss/search?q=affiliate%20marketing%20performance%20marketing&hl=en-IN&gl=IN&ceid=IN:en"],
  ["App Marketing", "https://news.google.com/rss/search?q=app%20marketing%20mobile%20growth&hl=en-IN&gl=IN&ceid=IN:en"]
];
// Research is shared/global across every user (public industry news, no
// reason to fetch it once per person) - only which articles a given user
// has already turned into a post (research_usage) is per-user.
async function collectResearch() {
  const found=[];
  const errors=[];
  for (const [source,url] of FEEDS) {
    try {
      const items = await fetchRssItems(url);
      for (const item of items.slice(0,8)) {
        if (!item.link || !item.title) continue;
        const relevance = Math.min(100, 50 + (item.title.match(/meta|google|ads|adtech|affiliate|performance|app|marketing/gi)||[]).length*8);
        await dbRun(`INSERT INTO research_items(title,summary,url,source,relevance,discovered_at) VALUES(?,?,?,?,?,?) ON CONFLICT (url) DO UPDATE SET title=excluded.title,summary=excluded.summary,relevance=excluded.relevance`,
          [item.title, (item.description||"").replace(/<[^>]+>/g,'').slice(0,700), item.link, source, relevance, nowStamp()]);
        found.push(item.title);
      }
    } catch (e) { console.error(`Research feed failed: ${source}: ${e.message}`); errors.push(`${source}: ${e.message}`); }
  }
  return { count: found.length, errors };
}

async function gemini(prompt, schema = null) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is missing.");
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const body = { contents:[{role:"user",parts:[{text:prompt}]}], generationConfig:{temperature:0.8} };
  if (schema) { body.generationConfig.responseMimeType="application/json"; body.generationConfig.responseSchema=schema; }
  const r = await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const data = await r.json().catch(()=>({})); if(!r.ok) throw new Error(`Gemini ${r.status}: ${data?.error?.message||JSON.stringify(data)}`);
  const text = data?.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("").trim(); if(!text) throw new Error("Gemini returned no content.");
  return text;
}

async function qualityCheck(content, recent = []) {
  const schema={type:"OBJECT",properties:{score:{type:"INTEGER"},issues:{type:"ARRAY",items:{type:"STRING"}},rewrite_needed:{type:"BOOLEAN"}},required:["score","issues","rewrite_needed"]};
  const prompt=`Evaluate this LinkedIn post for originality, specificity, natural human tone, useful insight, repetition, corporate fluff and AI-sounding language. Score 0-100. Do not judge political content. Never recommend CPS/CPL publisher content. Return JSON only.\n\nPOST:\n${content}\n\nRECENT TOPICS:\n${recent.slice(0,10).join(" | ")}`;
  try { return JSON.parse(await gemini(prompt,schema)); } catch { return {score:75,issues:[],rewrite_needed:false}; }
}

async function voiceContext(userId) {
  const examples=(await dbAll("SELECT content FROM voice_examples WHERE user_id=? ORDER BY id DESC LIMIT 8", [userId])).map(x=>x.content).join("\n---\n");
  return `VOICE INSTRUCTIONS:\n${await setting(userId, "voice_instructions")}\n\nVOICE EXAMPLES:\n${examples||"No examples added yet."}`;
}

async function generatePost(userId, requestedTopic = "", researchContext = "", requestedFormat = "", targetDate = "") {
  const availablePillars=await pillars(userId);
  const recent=await recentTopics(userId);
  const prior=(await recentContent(userId)).map(x=>`TOPIC: ${x.topic}\n${x.content.slice(0,500)}`).join("\n---\n");
  const research = researchContext || (await dbAll(
    `SELECT ri.title,ri.summary,ri.url,ri.source FROM research_items ri
     LEFT JOIN research_usage ru ON ru.research_item_id=ri.id AND ru.user_id=?
     WHERE ru.research_item_id IS NULL ORDER BY ri.relevance DESC, ri.discovered_at DESC LIMIT 8`, [userId]
  )).map(x=>`${x.title}\n${x.summary}\nSOURCE: ${x.url}`).join("\n---\n");
  const dateForEvents = targetDate || dayOffset(0);
  const todaysEvents = await eventsForDate(dateForEvents);
  const eventLine = todaysEvents.length ? `OBSERVANCE ON ${dateForEvents}: ${todaysEvents.map(e=>`${e.name}${e.notes?` (${e.notes})`:""}`).join(", ")}. Only tie the post to this if it is genuinely relevant to the audience described below — otherwise ignore it and write a normal post.` : "";
  const vc = await voiceContext(userId);
  const businessContext = (await setting(userId, "business_context") || "").trim();
  const businessLine = businessContext
    ? `BUSINESS CONTEXT (who this is for and what their business does - written by the user, treat as ground truth):\n${businessContext}`
    : `No business context has been set yet - write generally useful Performance Marketing/AdTech/business content and avoid inventing a specific employer or industry niche that hasn't been described.`;
  const prompt=`You are Dumadot, an AI LinkedIn content agent.\n\n${businessLine}\n\nSTRICT EXCLUSION:\nNever create, suggest, schedule or frame a post around CPS/CPL publishers, CPS/CPL publisher acquisition, publisher outreach for CPS/CPL offers, or similar publisher-recruitment content. This exclusion overrides every other instruction and must also apply when selecting automatic topics.\n\n${vc}\n\nCONTENT PILLARS:\n${availablePillars.join(", ")}\n\nRECENT TOPICS TO AVOID REPEATING:\n${recent.join(" | ")||"none"}\n\nRECENT POST SAMPLES TO AVOID COPYING:\n${prior}\n\nCURRENT RESEARCH:\n${research||"No research available. Use a timeless practical insight and do not invent statistics."}\n\n${eventLine}\n\nREQUESTED TOPIC: ${requestedTopic||"Choose a fresh topic."}\nREQUESTED FORMAT: ${requestedFormat||"Choose the format that best fits."}\n\nWrite a useful LinkedIn post. It must have a strong opening, short readable paragraphs, a clear point of view, concrete practical value, and a natural ending. No fake statistics, invented clients, payouts, volumes or results. If using a current fact, stay faithful to the supplied research. Do not mention that you are an AI. Use at most 5 hashtags. Return JSON only.`;
  const schema={type:"OBJECT",properties:{topic:{type:"STRING"},pillar:{type:"STRING"},format:{type:"STRING"},content:{type:"STRING"},hashtags:{type:"ARRAY",items:{type:"STRING"}},source_url:{type:"STRING"}},required:["topic","pillar","format","content","hashtags","source_url"]};
  const parsed=JSON.parse(await gemini(prompt,schema));
  if(isExcluded(`${parsed.topic} ${parsed.pillar} ${parsed.content}`)) throw new Error("Dumadot blocked an excluded CPS/CPL publisher topic. Generate again with a different angle.");
  const content=`${parsed.content.trim()}\n\n${(parsed.hashtags||[]).filter(x=>!isExcluded(x)).slice(0,5).join(" ")}`.trim();
  let q=await qualityCheck(content,recent);
  let finalContent=content;
  if(q.score < 70 || q.rewrite_needed){
    const rewritePrompt=`Rewrite this LinkedIn post to score at least 85 for originality, specificity and natural human tone. Keep the core idea, remove generic/AI language, strengthen the hook, and keep it practical. Never add CPS/CPL publisher content. Return only the rewritten post text, with no commentary.\n\nPOST:\n${content}`;
    try {
      finalContent=(await gemini(rewritePrompt)).trim();
      q=await qualityCheck(finalContent,recent);
    } catch {}
  }
  if(isExcluded(finalContent)) throw new Error("Dumadot blocked an excluded CPS/CPL publisher topic. Generate again with a different angle.");
  return {...parsed,content:finalContent,quality:q};
}

async function createDraft(userId, topic="", opts={}) {
  const post=await generatePost(userId, topic,opts.researchContext||"",opts.format||"",opts.targetDate||"");
  const row=await dbGet(`INSERT INTO posts(user_id,topic,content,status,pillar,format,quality_score,quality_notes,source_url,research_context,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    [userId,post.topic,post.content,"draft",post.pillar,post.format,post.quality.score,post.quality.issues.join(" | "),post.source_url||null,opts.researchContext||null,nowStamp(),nowStamp()]);
  return {id:row.id,...post,status:"draft"};
}
async function publishPost(userId, id) {
  const post=await dbGet("SELECT * FROM posts WHERE id=? AND user_id=?", [id, userId]); if(!post) throw new Error("Post not found."); if(post.status==="published") return post;
  const linkedinId=await publishToLinkedIn(userId, post.content,post.image_path);
  await dbRun("UPDATE posts SET status='published',linkedin_post_id=?,published_at=?,updated_at=? WHERE id=?", [linkedinId,nowStamp(),nowStamp(),id]);
  return dbGet("SELECT * FROM posts WHERE id=?", [id]);
}
async function markApproved(userId, id) {
  await dbRun("UPDATE posts SET status='approved',approved_at=?,updated_at=? WHERE id=? AND user_id=? AND status!='published'", [nowStamp(),nowStamp(),id,userId]);
  return dbGet("SELECT * FROM posts WHERE id=?", [id]);
}

async function createWeeklyPlan(userId, guidance="") {
  const existing=await dbAll("SELECT plan_date,pillar,topic FROM content_plans WHERE user_id=? AND plan_date>=? ORDER BY plan_date", [userId, dayOffset(0)]);
  const weekdays=[];
  for(let i=0;i<14 && weekdays.length<5;i++){
    const d=new Date(); d.setDate(d.getDate()+i);
    const dow=d.getDay(); if(dow===0||dow===6) continue;
    const key=new Intl.DateTimeFormat("en-CA",{timeZone:TIMEZONE,year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
    if(!existing.some(x=>x.plan_date===key)) weekdays.push(key);
  }
  if(!weekdays.length) return [];
  const research=await dbAll("SELECT title,summary,url FROM research_items ORDER BY relevance DESC, discovered_at DESC LIMIT 10");
  const activeIdeas=await dbAll("SELECT title,pillar,notes FROM ideas WHERE user_id=? AND status='idea' ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,id DESC LIMIT 20", [userId]);
  const events=await eventsInRange(weekdays[0],weekdays[weekdays.length-1]);
  const pillarList=await pillars(userId);
  const guidanceLine = guidance ? `USER GUIDANCE FOR THIS BATCH (follow this direction closely, it takes priority over inventing your own themes):\n${guidance}\n` : "";
  const ideasLine = activeIdeas.length ? `USER-SUBMITTED IDEAS (prefer using these over inventing new topics; assign each to the date/pillar that fits best):\n${activeIdeas.map(i=>`- ${i.title}${i.pillar?` [${i.pillar}]`:""}${i.notes?`: ${i.notes}`:""}`).join("\n")}\n` : "";
  const eventsLine = events.length ? `OBSERVANCES DURING THIS PERIOD (only tie a post to one if genuinely relevant to the intended audience; otherwise ignore it):\n${events.map(e=>`${e.event_date}: ${e.name}${e.notes?` (${e.notes})`:""}`).join("\n")}\n` : "";
  const prompt=`Create exactly ${weekdays.length} LinkedIn content-plan items for these exact dates: ${weekdays.join(", ")}. One item per date. Use only these pillars: ${pillarList.join(", ")}. Vary formats between insight, educational, contrarian, tactical, story and news reaction. Avoid recent topics and duplicate angles. STRICTLY NEVER include CPS, CPL, CPS/CPL publishers, publisher acquisition, publisher outreach or CPS/CPL offers. This is a hard exclusion.\n\n${guidanceLine}${ideasLine}${eventsLine}\nResearch available:\n${research.map(x=>`${x.title} | ${x.url}`).join("\n")}\nExisting plan:\n${existing.map(x=>`${x.plan_date} ${x.pillar} ${x.topic}`).join("\n")}`;
  const schema={type:"OBJECT",properties:{items:{type:"ARRAY",items:{type:"OBJECT",properties:{plan_date:{type:"STRING"},pillar:{type:"STRING"},topic:{type:"STRING"},format:{type:"STRING"},rationale:{type:"STRING"}},required:["plan_date","pillar","topic","format","rationale"]}}},required:["items"]};
  const parsed=JSON.parse(await gemini(prompt,schema));
  const created=[];
  for(const item of parsed.items.slice(0,weekdays.length)) {
    if(!weekdays.includes(item.plan_date) || isPlannerExcluded(JSON.stringify(item)) || !pillarList.includes(item.pillar)) continue;
    try { await dbRun("INSERT INTO content_plans(user_id,plan_date,pillar,topic,format,rationale,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT (user_id,plan_date) DO NOTHING", [userId,item.plan_date,item.pillar,item.topic,item.format,item.rationale,nowStamp()]); created.push(item); } catch {}
  }
  return created;
}

// Dynamic scheduler. No restart is required after changing the time. Loops
// over every user so each person's own postTime/autoPublish/plan runs
// independently - this is what makes each person's Duma actually independent
// rather than sharing one global schedule.
setInterval(async()=>{
  try{
    const local=nowLocalParts();
    const weekday=new Date().getDay();
    const users=await dbAll("SELECT id FROM users WHERE password_hash IS NOT NULL");
    for(const {id:userId} of users){
      try{
        const [ph,pm]=String((await setting(userId,"post_time"))||"10:30").split(":").map(Number);
        if(weekday!==0 && weekday!==6 && local.hour===ph && local.minute===pm && !(await dbGet("SELECT 1 FROM scheduler_runs WHERE user_id=? AND run_date=?", [userId, local.date]))){
          try{
            if((await setting(userId,"research_enabled"))==="true") await collectResearch();
            let plan=await dbGet("SELECT * FROM content_plans WHERE user_id=? AND plan_date=?", [userId, local.date]);
            if(!plan){ await createWeeklyPlan(userId, (await setting(userId,"planner_guidance"))||""); plan=await dbGet("SELECT * FROM content_plans WHERE user_id=? AND plan_date=?", [userId, local.date]); }
            const draft=await createDraft(userId, plan?.topic||"",{format:plan?.format||"",targetDate:local.date});
            const autoPublish=(await setting(userId,"auto_publish"))==="true";
            if(plan) await dbRun("UPDATE content_plans SET status=?,post_id=? WHERE id=?", [autoPublish?"published":"draft",draft.id,plan.id]);
            if(autoPublish){ await markApproved(userId, draft.id); await publishPost(userId, draft.id); console.log(`Dumadot published #${draft.id} for user ${userId}`); }
            else console.log(`Dumadot created draft #${draft.id} for user ${userId}`);
            await dbRun("INSERT INTO scheduler_runs(user_id,run_date,created_at) VALUES(?,?,?) ON CONFLICT (user_id,run_date) DO NOTHING", [userId, local.date,nowStamp()]);
          }catch(e){ console.error(`Dumadot scheduler failed for user ${userId}:`,e.message); }
        }
        // Explicit per-post scheduling always fires at its time, independent of the
        // master Auto-publish toggle: scheduling a specific post is itself the user's
        // explicit go-ahead. Auto-publish only gates the fully-automatic research->draft
        // pipeline above.
        const due=await dbAll("SELECT id FROM posts WHERE user_id=? AND scheduled_for IS NOT NULL AND scheduled_for!='' AND status IN ('approved','scheduled')", [userId]);
        for(const row of due){
          try{
            const post=await dbGet("SELECT * FROM posts WHERE id=?", [row.id]);
            if(post && post.scheduled_for && post.scheduled_for.slice(0,16)<=`${local.date}T${String(local.hour).padStart(2,'0')}:${String(local.minute).padStart(2,'0')}`) await publishPost(userId, post.id);
          }catch(e){ console.error(`Dumadot scheduled post #${row.id} failed:`,e.message); }
        }
      }catch(e){ console.error(`Dumadot scheduler tick failed for user ${userId}:`,e.message); }
    }
  }catch(e){ console.error("Dumadot scheduler tick failed:",e.message); }
},60000);

app.get("/api/export",async(req,res)=>{
  const uid=req.user.id;
  res.json({
    exported_at:new Date().toISOString(),
    settings:await dbAll("SELECT key,value FROM settings WHERE user_id=? ORDER BY key", [uid]),
    posts:await dbAll("SELECT * FROM posts WHERE user_id=? ORDER BY id", [uid]),
    ideas:await dbAll("SELECT * FROM ideas WHERE user_id=? ORDER BY id", [uid]),
    research:await dbAll("SELECT * FROM research_items ORDER BY id"),
    plans:await dbAll("SELECT * FROM content_plans WHERE user_id=? ORDER BY plan_date", [uid]),
    metrics:await dbAll("SELECT m.* FROM post_metrics m JOIN posts p ON p.id=m.post_id WHERE p.user_id=? ORDER BY m.post_id", [uid]),
    voice_examples:await dbAll("SELECT * FROM voice_examples WHERE user_id=? ORDER BY id", [uid])
  });
});
app.get("/api/status",async(req,res)=>{
  const uid=req.user.id;
  const token=await tokenRow(uid);
  res.json({
    appName:"Dumadot",
    me:{name:req.user.name,email:req.user.email,role:req.user.role},
    linkedinConnected:!!token,linkedinName:token?.name||null,
    postCount:Number((await dbGet("SELECT COUNT(*) n FROM posts WHERE user_id=?", [uid])).n),
    autoPublish:(await setting(uid,"auto_publish"))==="true",
    postTime:await setting(uid,"post_time"),
    pillars:await pillars(uid),
    researchEnabled:(await setting(uid,"research_enabled"))==="true",
    researchLastRun:(await setting(uid,"research_last_run"))||null,
    plannerGuidance:(await setting(uid,"planner_guidance"))||"",
    businessContext:(await setting(uid,"business_context"))||"",
  });
});
app.get("/auth/linkedin",(req,res)=>{ if(!process.env.LINKEDIN_CLIENT_ID||!process.env.LINKEDIN_CLIENT_SECRET)return res.status(400).send("Set LinkedIn credentials in .env first."); res.redirect(linkedinAuthUrl()); });
app.get("/auth/linkedin/callback",async(req,res)=>{try{if(req.query.error)return res.status(400).send(req.query.error_description||req.query.error);if(!req.query.code)return res.status(400).send("LinkedIn authorization code is missing.");await linkedinToken(req.user.id, req.query.code);res.redirect(`/?linkedin=connected`);}catch(e){res.status(500).send(e.message);}});

app.get("/api/posts",async(req,res)=>res.json(await dbAll("SELECT * FROM posts WHERE user_id=? ORDER BY COALESCE(scheduled_for,created_at) DESC LIMIT 100", [req.user.id])));
app.post("/api/generate",async(req,res)=>{try{res.json(await createDraft(req.user.id, req.body.topic||"",{format:req.body.format||"",researchContext:req.body.researchContext||""}));}catch(e){res.status(500).json({error:e.message});}});
app.patch("/api/posts/:id",async(req,res)=>{try{const owned=await dbGet("SELECT id FROM posts WHERE id=? AND user_id=?", [Number(req.params.id), req.user.id]); if(!owned) return res.status(404).json({error:"Post not found."}); const allowed=["topic","content","pillar","format","scheduled_for","status"];const fields=[];const vals=[];for(const k of allowed){if(req.body[k]!==undefined){fields.push(`${k}=?`);vals.push(req.body[k]);}}if(req.body.scheduled_for){fields.push("status=?");vals.push("scheduled");} else if(req.body.scheduled_for===null && req.body.status===undefined){fields.push("status=?");vals.push("draft");}if(!fields.length)return res.json(await dbGet("SELECT * FROM posts WHERE id=?", [Number(req.params.id)]));fields.push("updated_at=?");vals.push(nowStamp());vals.push(Number(req.params.id));await dbRun(`UPDATE posts SET ${fields.join(",")} WHERE id=?`, vals);res.json(await dbGet("SELECT * FROM posts WHERE id=?", [Number(req.params.id)]));}catch(e){res.status(500).json({error:e.message});}});
app.post("/api/posts/:id/approve",async(req,res)=>res.json(await markApproved(req.user.id, Number(req.params.id))));
app.post("/api/posts/:id/publish",async(req,res)=>{try{res.json(await publishPost(req.user.id, Number(req.params.id)));}catch(e){res.status(500).json({error:e.message});}});
app.delete("/api/posts/:id",async(req,res)=>{await dbRun("DELETE FROM posts WHERE id=? AND user_id=?", [Number(req.params.id), req.user.id]);res.json({ok:true});});
app.post("/api/posts/:id/image",async(req,res)=>{
  try{
    const post=await dbGet("SELECT * FROM posts WHERE id=? AND user_id=?", [Number(req.params.id), req.user.id]);
    if(!post) return res.status(404).json({error:"Post not found."});
    const dataUrl=String(req.body.dataUrl||"");
    const m=dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
    if(!m) return res.status(400).json({error:"Invalid image data (must be a PNG, JPEG or WEBP data URL)."});
    const buf=Buffer.from(m[2],"base64");
    if(buf.length>8*1024*1024) return res.status(400).json({error:"Image too large (max 8MB)."});
    const ext=m[1].toLowerCase()==="jpeg"?"jpg":m[1].toLowerCase();
    const filename=`post-${post.id}-${Date.now()}.${ext}`;
    fs.writeFileSync(`public/uploads/${filename}`,buf);
    if(post.image_path){ try{ fs.unlinkSync(`public${post.image_path}`); }catch{} }
    const rel=`/uploads/${filename}`;
    await dbRun("UPDATE posts SET image_path=?,updated_at=? WHERE id=?", [rel,nowStamp(),post.id]);
    res.json(await dbGet("SELECT * FROM posts WHERE id=?", [post.id]));
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.delete("/api/posts/:id/image",async(req,res)=>{
  const post=await dbGet("SELECT * FROM posts WHERE id=? AND user_id=?", [Number(req.params.id), req.user.id]);
  if(!post) return res.status(404).json({error:"Post not found."});
  if(post.image_path){ try{ fs.unlinkSync(`public${post.image_path}`); }catch{} }
  await dbRun("UPDATE posts SET image_path=NULL,updated_at=? WHERE id=?", [nowStamp(),post.id]);
  res.json(await dbGet("SELECT * FROM posts WHERE id=?", [post.id]));
});

app.get("/api/ideas",async(req,res)=>res.json(await dbAll("SELECT * FROM ideas WHERE user_id=? ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,id DESC", [req.user.id])));
app.post("/api/ideas",async(req,res)=>{if(!req.body.title||isExcluded(req.body.title))return res.status(400).json({error:"That idea is excluded from Dumadot's automatic content system."});const row=await dbGet("INSERT INTO ideas(user_id,title,pillar,notes,source_url,priority,created_at) VALUES(?,?,?,?,?,?,?) RETURNING *", [req.user.id,req.body.title,req.body.pillar||null,req.body.notes||null,req.body.source_url||null,req.body.priority||"normal",nowStamp()]);res.json(row);});
app.post("/api/ideas/:id/generate",async(req,res)=>{try{const idea=await dbGet("SELECT * FROM ideas WHERE id=? AND user_id=?", [Number(req.params.id), req.user.id]);if(!idea)throw new Error("Idea not found.");const d=await createDraft(req.user.id, idea.title,{researchContext:idea.source_url?`Source: ${idea.source_url}\nNotes: ${idea.notes||""}`:idea.notes||""});await dbRun("UPDATE ideas SET status='used' WHERE id=?", [idea.id]);res.json(d);}catch(e){res.status(500).json({error:e.message});}});
app.delete("/api/ideas/:id",async(req,res)=>{await dbRun("DELETE FROM ideas WHERE id=? AND user_id=?", [Number(req.params.id), req.user.id]);res.json({ok:true});});

app.get("/api/research",async(req,res)=>{
  res.json(await dbAll(
    `SELECT ri.*, (ru.research_item_id IS NOT NULL) as used_by_me FROM research_items ri
     LEFT JOIN research_usage ru ON ru.research_item_id=ri.id AND ru.user_id=?
     ORDER BY ri.relevance DESC, ri.discovered_at DESC LIMIT 100`, [req.user.id]
  ));
});
app.post("/api/research/refresh",async(req,res)=>{try{const {count,errors}=await collectResearch();await updateSetting(req.user.id,"research_last_run",new Date().toISOString());res.json({ok:true,count,errors});}catch(e){res.status(500).json({error:e.message});}});
app.post("/api/research/:id/generate",async(req,res)=>{try{const x=await dbGet("SELECT * FROM research_items WHERE id=?", [Number(req.params.id)]);if(!x)throw new Error("Research item not found.");const d=await createDraft(req.user.id, "",{researchContext:`${x.title}\n${x.summary}\nSOURCE: ${x.url}`});await dbRun("INSERT INTO research_usage(user_id,research_item_id,used_at) VALUES(?,?,?) ON CONFLICT DO NOTHING", [req.user.id, x.id, nowStamp()]);res.json(d);}catch(e){res.status(500).json({error:e.message});}});

app.get("/api/plans",async(req,res)=>res.json(await dbAll("SELECT * FROM content_plans WHERE user_id=? ORDER BY plan_date ASC LIMIT 60", [req.user.id])));
app.post("/api/plans/generate",async(req,res)=>{try{const guidance=String(req.body.guidance||"").trim();if(guidance)await updateSetting(req.user.id,"planner_guidance",guidance);const items=await createWeeklyPlan(req.user.id, guidance||(await setting(req.user.id,"planner_guidance"))||"");res.json({ok:true,items});}catch(e){res.status(500).json({error:e.message});}});
app.post("/api/plans/:id/generate",async(req,res)=>{try{const p=await dbGet("SELECT * FROM content_plans WHERE id=? AND user_id=?", [Number(req.params.id), req.user.id]);if(!p)throw new Error("Plan item not found.");const d=await createDraft(req.user.id, p.topic,{format:p.format,targetDate:p.plan_date});await dbRun("UPDATE content_plans SET status='draft',post_id=? WHERE id=?", [d.id,p.id]);res.json(d);}catch(e){res.status(500).json({error:e.message});}});

// Calendar events are a shared, global list of real-world observances - not
// per-user - since they're objective dates, not personal content.
app.get("/api/calendar-events",async(req,res)=>{const from=req.query.from||dayOffset(0);const to=req.query.to||dayOffset(365);res.json(await eventsInRange(from,to));});
app.post("/api/calendar-events",async(req,res)=>{const {event_date,name,notes,recurring_yearly}=req.body;if(!event_date||!name)return res.status(400).json({error:"event_date and name are required."});const row=await dbGet("INSERT INTO calendar_events(event_date,name,notes,recurring_yearly,created_at) VALUES(?,?,?,?,?) RETURNING *", [event_date,name,notes||null,recurring_yearly?1:0,nowStamp()]);res.json(row);});
app.delete("/api/calendar-events/:id",async(req,res)=>{await dbRun("DELETE FROM calendar_events WHERE id=?", [Number(req.params.id)]);res.json({ok:true});});

app.get("/api/analytics",async(req,res)=>{
  const uid=req.user.id;
  const posts=await dbAll(`SELECT p.*,COALESCE(m.impressions,0) impressions,COALESCE(m.reactions,0) reactions,COALESCE(m.comments,0) comments,COALESCE(m.reposts,0) reposts,COALESCE(m.clicks,0) clicks FROM posts p LEFT JOIN post_metrics m ON m.post_id=p.id WHERE p.status='published' AND p.user_id=? ORDER BY p.published_at DESC`, [uid]);
  const totals=posts.reduce((a,p)=>{a.impressions+=p.impressions;a.engagements+=p.reactions+p.comments+p.reposts;a.clicks+=p.clicks;return a},{impressions:0,engagements:0,clicks:0});
  const byPillar={};
  for(const p of posts){const k=p.pillar||"Unclassified";byPillar[k]??={posts:0,impressions:0,engagements:0};byPillar[k].posts++;byPillar[k].impressions+=p.impressions;byPillar[k].engagements+=p.reactions+p.comments+p.reposts;}
  const measured=posts.filter(p=>p.impressions>0||p.reactions>0||p.comments>0||p.reposts>0);
  const byHour={}, byWeekday={};
  for(const p of measured){
    const lhw=localHourWeekday(p.published_at); if(!lhw) continue;
    const eng=p.reactions+p.comments+p.reposts;
    byHour[lhw.hour]??={posts:0,engagements:0}; byHour[lhw.hour].posts++; byHour[lhw.hour].engagements+=eng;
    byWeekday[lhw.weekday]??={posts:0,engagements:0}; byWeekday[lhw.weekday].posts++; byWeekday[lhw.weekday].engagements+=eng;
  }
  const rankByAvg=obj=>Object.entries(obj).map(([k,v])=>({key:k,posts:v.posts,engagements:v.engagements,avg:v.engagements/v.posts})).sort((a,b)=>b.avg-a.avg);
  const hourRanking=rankByAvg(byHour);
  const weekdayRanking=rankByAvg(byWeekday);
  const pillarRanking=Object.entries(byPillar).map(([k,v])=>({key:k,posts:v.posts,engagements:v.engagements,avg:v.posts?v.engagements/v.posts:0})).sort((a,b)=>b.avg-a.avg);
  const now=Date.now(); const day=86400000;
  const inWindow=(p,startMs,endMs)=>{const t=Date.parse((p.published_at||"").replace(" ","T")+((p.published_at||"").includes("Z")?"":"Z"));return !isNaN(t)&&t>=startMs&&t<endMs;};
  const last30=measured.filter(p=>inWindow(p,now-30*day,now));
  const prev30=measured.filter(p=>inWindow(p,now-60*day,now-30*day));
  const engSum=arr=>arr.reduce((a,p)=>a+p.reactions+p.comments+p.reposts,0);
  const last30Eng=engSum(last30), prev30Eng=engSum(prev30);
  const trend={last30Posts:last30.length,prev30Posts:prev30.length,last30Engagements:last30Eng,prev30Engagements:prev30Eng,changePct:prev30Eng>0?Math.round(((last30Eng-prev30Eng)/prev30Eng)*100):(last30Eng>0?100:0)};
  const insights={
    bestHour: hourRanking[0] ? `${hourRanking[0].key}:00` : null,
    bestWeekday: weekdayRanking[0] ? weekdayRanking[0].key : null,
    hourRanking, weekdayRanking, pillarRanking, trend,
    sampleSize: measured.length,
    note: measured.length < 5 ? "Add metrics (via 'Save metrics' on published posts) for more posts to get reliable timing insights." : null
  };
  res.json({posts,totals,byPillar,insights});
});
app.post("/api/analytics/:id",async(req,res)=>{const owned=await dbGet("SELECT id FROM posts WHERE id=? AND user_id=?", [Number(req.params.id), req.user.id]); if(!owned) return res.status(404).json({error:"Post not found."}); const vals=["impressions","reactions","comments","reposts","clicks"].map(k=>Math.max(0,Number(req.body[k]||0)));await dbRun(`INSERT INTO post_metrics(post_id,impressions,reactions,comments,reposts,clicks,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT (post_id) DO UPDATE SET impressions=excluded.impressions,reactions=excluded.reactions,comments=excluded.comments,reposts=excluded.reposts,clicks=excluded.clicks,updated_at=excluded.updated_at`, [Number(req.params.id),...vals,nowStamp()]);res.json({ok:true});});

app.get("/api/voice",async(req,res)=>res.json({instructions:await setting(req.user.id,"voice_instructions"),examples:await dbAll("SELECT * FROM voice_examples WHERE user_id=? ORDER BY id DESC", [req.user.id])}));
app.post("/api/voice",async(req,res)=>{if(req.body.instructions!==undefined)await updateSetting(req.user.id,"voice_instructions",req.body.instructions);if(req.body.example){await dbRun("INSERT INTO voice_examples(user_id,content,created_at) VALUES(?,?,?)", [req.user.id,req.body.example,nowStamp()]);}res.json({ok:true});});
app.delete("/api/voice/examples/:id",async(req,res)=>{await dbRun("DELETE FROM voice_examples WHERE id=? AND user_id=?", [Number(req.params.id), req.user.id]);res.json({ok:true});});

app.post("/api/settings",async(req,res)=>{
  const uid=req.user.id;
  if(req.body.postTime)await updateSetting(uid,"post_time",req.body.postTime);
  if(typeof req.body.autoPublish==="boolean")await updateSetting(uid,"auto_publish",String(req.body.autoPublish));
  if(Array.isArray(req.body.pillars))await updateSetting(uid,"content_pillars",req.body.pillars.filter(p=>!isExcluded(p)).join(","));
  if(typeof req.body.researchEnabled==="boolean")await updateSetting(uid,"research_enabled",String(req.body.researchEnabled));
  if(typeof req.body.businessContext==="string")await updateSetting(uid,"business_context",req.body.businessContext);
  res.json({ok:true,autoPublish:(await setting(uid,"auto_publish"))==="true",postTime:await setting(uid,"post_time"),pillars:await pillars(uid),businessContext:(await setting(uid,"business_context"))||""});
});

// Dotbots workforce coordination: shared job queue + registry + event log
// (see lib/bots.js). Dumadot is the first bot wired to it, handling
// generate_post/publish_post jobs that any other bot can enqueue - jobs now
// carry a userId in their payload so the right person's data gets touched.
app.get("/api/bots/status",async(req,res)=>{
  const bots=await dbAll("SELECT * FROM bot_registry ORDER BY name");
  const events=await dbAll("SELECT * FROM bot_events ORDER BY id DESC LIMIT 50");
  const jobCounts=await dbAll("SELECT bot_name, status, COUNT(*)::int as n FROM bot_jobs GROUP BY bot_name, status ORDER BY bot_name, status");
  res.json({bots,events,jobCounts});
});
app.get("/api/bots/jobs",async(req,res)=>{
  const conditions=[];const vals=[];
  if(req.query.bot_name){conditions.push("bot_name=?");vals.push(req.query.bot_name);}
  if(req.query.status){conditions.push("status=?");vals.push(req.query.status);}
  const where=conditions.length?`WHERE ${conditions.join(" AND ")}`:"";
  res.json(await dbAll(`SELECT * FROM bot_jobs ${where} ORDER BY id DESC LIMIT 100`, vals));
});
app.post("/api/bots/jobs",async(req,res)=>{
  try{
    const {botName,jobType,payload,nextJob}=req.body;
    if(!botName||!jobType) return res.status(400).json({error:"botName and jobType are required."});
    const job=await enqueueJob(pool,{botName,jobType,payload:{userId:req.user.id, ...(payload||{})},createdBy:"api",nextJob:nextJob||null});
    res.json(job);
  }catch(e){ res.status(500).json({error:e.message}); }
});

(async () => {
  await initDb();
  startWorker(pool, BOT_NAME, {
    generate_post: async (payload) => {
      if (!payload.userId) throw new Error("generate_post requires payload.userId");
      const draft = await createDraft(payload.userId, payload.topic||"", {format:payload.format||"",researchContext:payload.researchContext||"",targetDate:payload.targetDate||""});
      return { postId: draft.id, topic: draft.topic, pillar: draft.pillar };
    },
    publish_post: async (payload) => {
      if (!payload.userId) throw new Error("publish_post requires payload.userId");
      if (!payload.postId) throw new Error("publish_post requires payload.postId");
      const post = await publishPost(payload.userId, Number(payload.postId));
      return { postId: post.id, status: post.status, linkedinPostId: post.linkedin_post_id };
    },
  });
  await heartbeat(pool, BOT_NAME, "idle", { version: "3.0.0" });
  app.listen(PORT,()=>console.log(`Dumadot running at ${baseUrl()}`));
})();
