// Utilitários compartilhados pelas páginas públicas (chat.html e form.html).
// Prefill, UTMs e chamadas a /api/public/* — mantenha as duas páginas usando daqui.

const API = window.INGRESSO_CONFIG?.apiBase || "/api";

function escHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

const PREFILL_KEY_ALIASES = {
    email_lead: "email",
    nome_lead: "nome",
    phone_lead: "telefone",
};

function normalizePrefillKey(key) {
    return PREFILL_KEY_ALIASES[key] ?? key;
}

function getUtmParams() {
    const params = new URLSearchParams(window.location.search);
    const meta = {};
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref"].forEach((k) => {
        if (params.has(k)) meta[k] = params.get(k);
    });
    // Cookies com prefixo utm_ sobrepõem URL
    document.cookie.split(";").forEach((c) => {
        const [rawKey, rawVal] = c.trim().split("=");
        const key = rawKey?.trim();
        if (key && key.startsWith("utm_")) meta[key] = decodeURIComponent(rawVal || "");
    });
    return Object.keys(meta).length ? meta : null;
}

// Query params aceitos sem o prefixo v_ — user_id/email/role vêm dos links
// do Asimov Work (?user_id=...&email=...&role=...)
const PREFILL_URL_KEYS = [
    "user_id", "email", "role",
    "name", "nome", "phone", "telefone",
    ...Object.keys(PREFILL_KEY_ALIASES),
];

function getPrefillParams() {
    const params = new URLSearchParams(window.location.search);
    const prefill = {};

    // Percorre na ordem em que aparecem na URL: essa ordem define a ordem
    // das colunas novas criadas no Google Sheets.
    params.forEach((value, key) => {
        if (key.startsWith("v_")) {
            // Suporte genérico: ?v_variavel=valor → { variavel: valor }
            prefill[normalizePrefillKey(key.slice(2))] = value;
        } else if (PREFILL_URL_KEYS.includes(key)) {
            prefill[normalizePrefillKey(key)] = value;
        }
    });

    // Cookies terminando em _lead sobrepõem URL (com normalização)
    document.cookie.split(";").forEach((c) => {
        const [rawKey, rawVal] = c.trim().split("=");
        const key = rawKey?.trim();
        if (key && key.endsWith("_lead")) prefill[normalizePrefillKey(key)] = decodeURIComponent(rawVal || "");
    });

    return prefill;
}

function interpolate(text, vars) {
    return text.replace(/\{(\w+)\}/g, (_, key) => (vars[key] !== undefined ? vars[key] : `{${key}}`));
}

async function apiPost(path, body) {
    const res = await fetch(`${API}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || "Erro");
    }
    return res.json();
}

// ─── Navegação entre blocos ───────────────────────────────────────────────
// Pulo condicional e depois segue linear. Espelhado em flow-graph.js.

function nextBlockIndex(blocks, currentIndex, block, answer) {
    if (!block || !block.conditions || !block.conditions.length) {
        return currentIndex + 1;
    }

    const answersToCheck = block.type === "multiple_choice"
        ? String(answer).split(", ").map((s) => s.trim())
        : [String(answer).trim()];

    for (const a of answersToCheck) {
        const match = block.conditions.find((c) => String(c.answer).trim() === a);
        if (match) {
            if (match.target_block_id === "__finish__") return blocks.length;
            const idx = blocks.findIndex((b) => b.id === match.target_block_id);
            if (idx !== -1) return idx;
        }
    }
    return currentIndex + 1;
}

// ─── Validadores / Máscaras ───────────────────────────────────────────────

function isValidEmail(str) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

function applyPhoneMask(input) {
    input.addEventListener("input", (e) => {
        let v = e.target.value.replace(/\D/g, "").slice(0, 11);
        if (v.length > 6) v = `(${v.slice(0,2)}) ${v.slice(2,7)}-${v.slice(7)}`;
        else if (v.length > 2) v = `(${v.slice(0,2)}) ${v.slice(2)}`;
        else if (v.length > 0) v = `(${v}`;
        e.target.value = v;
    });
}
