// Machine-to-machine surface so Dobydot (the personal-assistant agent) can
// ask this bot to do things on a person's behalf. It deliberately reuses the
// bot's own draft/publish code paths - nothing here reimplements posting.
//
// Auth is two headers: x-agent-key (a long shared secret, AGENT_API_KEY) and
// x-agent-user (the email of the person being acted for; must be a claimed
// account on THIS service, so an assistant can only ever act as someone who
// already has an account here). With no AGENT_API_KEY set the whole surface
// is off. It is mounted before the login wall because Dobydot has no
// browser session - the key is the only way in.
import crypto from "node:crypto";

function sameSecret(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function attachAgentApi(app, pool, { name, draft, publish, discard, run }) {
  const guard = async (req, res, next) => {
    try {
      const key = process.env.AGENT_API_KEY;
      if (!key) return res.status(503).json({ error: "Agent API is not configured on this service." });
      if (!sameSecret(req.get("x-agent-key") || "", key)) return res.status(401).json({ error: "Bad agent key." });
      const email = String(req.get("x-agent-user") || "").trim().toLowerCase();
      const r = await pool.query("SELECT id,email,name FROM users WHERE lower(email)=$1 AND password_hash IS NOT NULL", [email]);
      if (!r.rows[0]) return res.status(403).json({ error: `No active ${name} account for ${email || "(no email given)"}.` });
      req.agentUser = r.rows[0];
      next();
    } catch (e) { res.status(500).json({ error: e.message }); }
  };
  const wrap = (fn) => async (req, res) => {
    try {
      if (!fn) return res.status(404).json({ error: "Not supported by this agent." });
      res.json(await fn(req.agentUser, req.body || {}));
    } catch (e) { res.status(500).json({ error: e.message }); }
  };
  app.get("/api/agent/ping", guard, (req, res) => res.json({ ok: true, agent: name, user: req.agentUser.email }));
  app.post("/api/agent/draft", guard, wrap(draft && ((u, b) => draft(u, b.params || {}))));
  app.post("/api/agent/publish", guard, wrap(publish && ((u, b) => publish(u, String(b.handle || "")))));
  app.post("/api/agent/discard", guard, wrap(discard && ((u, b) => discard(u, String(b.handle || "")))));
  app.post("/api/agent/run", guard, wrap(run && ((u, b) => run(u, String(b.action || ""), b.params || {}))));
}
