// Local preview only. The exported frontend keeps the original /api/public contract.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { dirname, join, resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontend = join(root, "frontend");
const stateDir = resolve(process.env.DEMO_STATE_DIR || join(root, ".local"));
const stateFile = join(stateDir, "sessions.json");
const slugs = ["pesquisa-leads-bf-2026", "pesquisa-leads-bf-2026-emissao"];
const flows = slugs.map(slug => JSON.parse(readFileSync(join(root, "examples", "flows", `${slug}.json`))));
const sessions = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile)) : {};
const port = Number(process.env.PORT || 8003);
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8" };

function persist() {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(sessions, null, 2));
    renameSync(`${stateFile}.tmp`, stateFile);
}

function json(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
}

const normalize = value => String(value ?? "").trim().toLowerCase();
function resolveLink(flow, session) {
    const values = Object.fromEntries(Object.entries(session.prefill).map(([key, value]) => [key, [normalize(value)]]));
    for (const response of Object.values(session.responses)) {
        const block = flow.blocks.find(b => b.id === response.block_id);
        values[block.variable_name] = block.type === "multiple_choice"
            ? [...response.answer.split(", ").map(normalize), normalize(response.answer)]
            : [normalize(response.answer)];
    }
    for (const rule of flow.conditional_links || []) {
        const conditions = (rule.conditions || [rule]).filter(c => c.variable_name);
        if (!rule.link?.trim() || !conditions.length) continue;
        const results = conditions.map(c => (Array.isArray(c.answers) ? c.answers : [c.answer]).some(v => (values[c.variable_name] || []).includes(normalize(v))));
        if (rule.match === "any" ? results.some(Boolean) : results.every(Boolean)) return rule.link;
    }
    return flow.whatsapp_link || null;
}

async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_048_576) throw new Error("Requisição muito grande");
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

const server = createServer(async (req, res) => {
    try {
        const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
        if (req.method === "GET" && path.startsWith("/api/public/f/")) {
            const flow = flows.find(f => f.slug === path.slice("/api/public/f/".length) && f.is_active);
            if (!flow) return json(res, 404, { detail: "Fluxo não encontrado" });
            return json(res, 200, { ...flow, blocks: flow.blocks.filter(b => b.is_active) });
        }
        if (req.method === "POST" && path === "/api/public/sessions") {
            const data = await body(req);
            const flow = flows.find(f => f.id === data.flow_id && f.is_active);
            if (!flow) return json(res, 404, { detail: "Fluxo não encontrado" });
            const id = randomUUID();
            const session = { id, flow_id: flow.id, started_at: new Date().toISOString(), prefill: data.prefill || {}, meta: data.meta || {}, responses: {}, is_completed: false, clicked_link: false, resolved_link: null };
            const byVariable = new Map(flow.blocks.filter(b => b.is_active && b.variable_name).map(b => [b.variable_name, b]));
            for (const [key, value] of Object.entries(session.prefill)) {
                const block = byVariable.get(key);
                if (block) session.responses[block.id] = { block_id: block.id, answer: String(value) };
            }
            sessions[id] = session;
            persist();
            return json(res, 200, { session_id: id });
        }
        if (req.method === "POST" && ["/api/public/sessions/answer", "/api/public/sessions/complete"].includes(path)) {
            const data = await body(req);
            const session = sessions[data.session_id];
            if (!session) return json(res, 404, { detail: "Sessão não encontrada" });
            const flow = flows.find(f => f.id === session.flow_id);
            if (path.endsWith("/answer")) {
                const block = flow.blocks.find(b => b.id === data.block_id);
                if (!block) return json(res, 404, { detail: "Bloco não encontrado" });
                if (block.variable_name) session.responses[block.id] = { block_id: block.id, answer: String(data.answer ?? "") };
                persist();
                return json(res, 200, { ok: true });
            }
            if (!session.is_completed) {
                session.is_completed = true;
                session.completed_at = new Date().toISOString();
                session.resolved_link = resolveLink(flow, session);
                persist();
            }
            return json(res, 200, { whatsapp_link: session.resolved_link });
        }
        const redirect = path.match(/^\/api\/public\/sessions\/([^/]+)\/redirect$/);
        if (req.method === "GET" && redirect) {
            const session = sessions[redirect[1]];
            if (!session?.resolved_link) return json(res, 404, { detail: "Link não encontrado" });
            session.clicked_link = true;
            persist();
            res.writeHead(302, { Location: session.resolved_link });
            return res.end();
        }
        if (path.startsWith("/api/")) return json(res, 404, { detail: "Endpoint não encontrado" });
        if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { detail: "Método não permitido" });
        let relative = path === "/" ? "index.html" : path.slice(1);
        if (path.startsWith("/f/")) {
            if (!slugs.includes(path.slice(3).replace(/\/$/, ""))) return json(res, 404, { detail: "Fluxo não encontrado" });
            relative = "form.html";
        }
        const file = resolve(frontend, relative);
        if (!file.startsWith(`${frontend}${sep}`)) return json(res, 404, { detail: "Arquivo não encontrado" });
        let contents;
        try { contents = readFileSync(file); } catch { return json(res, 404, { detail: "Arquivo não encontrado" }); }
        res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
        res.end(req.method === "HEAD" ? undefined : contents);
    } catch (error) {
        console.error(error.message);
        json(res, 400, { detail: "Requisição inválida" });
    }
});

server.listen(port, "127.0.0.1", () => {
    console.log(`Prévia: http://127.0.0.1:${server.address().port}`);
    console.log("Sessões de demonstração locais; sem conexão com Google Sheets.");
});
