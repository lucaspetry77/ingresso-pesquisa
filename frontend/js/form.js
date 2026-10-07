// Template "form" (flow_type = "form"): uma pergunta por tela e um ingresso
// ao lado que vai sendo preenchido com as respostas. Mesmos blocos, prefill,
// pulos condicionais e endpoints do chat — só muda a apresentação.

let sessionId = null;
let blocks = [];
let flowData = null;
let currentIndex = 0;
let prefillVars = {};
let collectedVars = {};
let currentSlug = null;
// Caminho percorrido: { i, shown }. "shown" = o usuário viu a tela (prefill pula).
// Serve para o "Voltar" e para detectar loop (mesma regra do visitedBlockIds do chat).
let path = [];
// Resposta exibida no ingresso, por bloco (dois blocos podem usar a mesma variável)
let answersByBlock = {};
let busy = false;
let typingTimer = null;
const pendingAnswers = new Set();

const INPUT_TYPES = ["text_input", "email_input", "phone_input", "single_choice", "multiple_choice"];
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = (sel) => document.querySelector(sel);
const qbox = () => $("#fm-qbox");

// ─── Estado salvo (retomar de onde parou) ─────────────────────────────────

function saveSessionState() {
    if (!currentSlug || !sessionId) return;
    localStorage.setItem(`typebot_session_${currentSlug}`, JSON.stringify({
        sessionId, currentIndex, collectedVars, path, answersByBlock,
    }));
}

function clearSessionState() {
    if (currentSlug) localStorage.removeItem(`typebot_session_${currentSlug}`);
}

// ─── Ingresso ─────────────────────────────────────────────────────────────

const isInputBlock = (b) => INPUT_TYPES.includes(b.type) && b.variable_name;

// Próximo bloco "provável" de um bloco ainda não respondido: se todas as opções
// levam ao mesmo lugar (ex.: todas → __finish__), é esse; senão, segue linear.
function predictNext(i) {
    const b = blocks[i];
    if (!b.conditions?.length || !b.options?.length) return i + 1;
    const targets = new Set(b.options.map((opt) => nextBlockIndex(blocks, i, b, opt)));
    return targets.size === 1 ? [...targets][0] : i + 1;
}

// Caminho previsto: o que a pessoa já percorreu + a projeção a partir da tela atual.
// Com ramificação (ex.: aluno / não aluno), o ingresso e a contagem mostram só o
// ramo em que ela está, e se reajustam quando um pulo muda o caminho.
function projectedBlocks({ onlyWalked = false } = {}) {
    const seen = new Set();
    const out = [];
    const add = (i) => { if (!seen.has(i)) { seen.add(i); out.push(i); } };
    path.forEach((p) => add(p.i));
    if (!onlyWalked) {
        let i = currentIndex;
        for (let steps = 0; i < blocks.length && steps <= blocks.length; steps++) {
            if (i !== currentIndex && seen.has(i)) break; // loop: para a projeção
            add(i);
            i = predictNext(i);
        }
    }
    return out.map((i) => blocks[i]);
}

const inputBlocks = (opts) => projectedBlocks(opts).filter(isInputBlock);

function fieldLabel(variableName) {
    return variableName.replace(/_/g, " ");
}

// countdown_date vem do painel sem fuso ("2026-11-04T19:00"): é horário de Brasília.
// Fixa em -03:00 (sem horário de verão desde 2019) para o contador valer em qualquer fuso.
const BRT_OFFSET = "-03:00";

function parseCountdown(value) {
    if (!value) return null;
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value);
    const d = new Date(hasZone ? value : `${value.length === 16 ? `${value}:00` : value}${BRT_OFFSET}`);
    return isNaN(d) ? null : d;
}

// Partes da data/hora em Brasília, para exibir "04.11.26" / "19h00" igual ao configurado
function brtParts(date) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(date).map((x) => [x.type, x.value]));
    return { dd: p.day, mm: p.month, yy: p.year, hh: p.hour, mi: p.minute };
}

function renderTicket() {
    $("#fm-ttitle").alt = flowData.page_title?.trim() || flowData.name;
    const subtitle = flowData.ticket_subtitle?.trim();
    if (subtitle) {
        $("#fm-tsubtitle").textContent = subtitle;
        $("#fm-tsubtitle").hidden = false;
    }

    const hex = (sessionId || "").replace(/-/g, "");
    $("#fm-tnum").textContent = hex ? String(parseInt(hex.slice(0, 6), 16) % 9000 + 1000) : "—";

    const date = parseCountdown(flowData.countdown_date);
    if (date) {
        const { dd, mm, yy, hh, mi } = brtParts(date);
        $("#fm-tdate").textContent = `${dd}.${mm}.${yy}`;
        $("#fm-ttime").textContent = `${hh}h${mi}`;
        $("#fm-stamp-date").textContent = `${dd}.${mm} · ${hh}h`;
        $("#fm-tmeta").hidden = false;
        tickCountdown(date);
    }

    renderTicketFields();
}

// Linhas do ingresso para o caminho atual. Respostas já dadas (ou pré-preenchidas)
// entram sem animação; a da pergunta recém-respondida é digitada em setTicketValue.
function renderTicketFields(opts) {
    $("#fm-tfields").innerHTML = inputBlocks(opts).map((b) => {
        const v = answersByBlock[b.id] ?? prefillVars[b.variable_name];
        const filled = v !== undefined && v !== "";
        return `
        <div class="fm-t-cell fm-t-field" data-block="${escHtml(b.id)}">
            <span class="fm-t-label">${escHtml(b.ticket_label?.trim() || fieldLabel(b.variable_name))}</span>
            <span class="fm-t-value ${filled ? "" : "empty"}" ${filled ? `title="${escHtml(v)}"` : ""}>${filled ? escHtml(v) : "—"}</span>
        </div>`;
    }).join("");
}

// Contador ao vivo, segundo a segundo, alinhado à virada do segundo do relógio
function tickCountdown(date) {
    const diff = date - Date.now();
    const setCount = (text) => document.querySelectorAll(".fm-t-count").forEach((n) => { n.textContent = text; });
    if (diff <= 0) { setCount("ao vivo agora"); return; }
    const pad = (n) => String(n).padStart(2, "0");
    const d = Math.floor(diff / 864e5);
    const h = Math.floor((diff % 864e5) / 36e5);
    const m = Math.floor((diff % 36e5) / 6e4);
    const sec = Math.floor((diff % 6e4) / 1e3);
    setCount(`${d}d ${pad(h)}h ${pad(m)}m ${pad(sec)}s`); // inclui as faixas do papel-tecido
    setTimeout(() => tickCountdown(date), (diff % 1000) || 1000);
}

function ticketValueEl(blockId) {
    return document.querySelector(`.fm-t-field[data-block="${CSS.escape(blockId)}"] .fm-t-value`);
}

function setActiveField(blockId) {
    document.querySelectorAll(".fm-t-field").forEach((f) => {
        f.classList.toggle("active", f.dataset.block === blockId);
    });
}

// Escreve a resposta no ingresso com cursor de máquina de escrever.
function setTicketValue(blockId, text, animate, onDone) {
    const el = ticketValueEl(blockId);
    clearInterval(typingTimer);
    if (!el) { onDone?.(); return; }
    el.classList.remove("empty");
    el.title = text;
    if (!animate || reducedMotion) {
        el.textContent = text;
        onDone?.();
        return;
    }
    const speed = Math.max(12, Math.min(32, 640 / text.length));
    let i = 0;
    el.innerHTML = '<span class="fm-caret"></span>';
    typingTimer = setInterval(() => {
        i++;
        el.innerHTML = `${escHtml(text.slice(0, i))}<span class="fm-caret"></span>`;
        if (i >= text.length) {
            clearInterval(typingTimer);
            setTimeout(() => { el.textContent = text; onDone?.(); }, 160);
        }
    }, speed);
}

// ─── Progresso ────────────────────────────────────────────────────────────

// Conta só perguntas que o usuário vai ver (as pré-preenchidas são puladas).
function askableBlocks() {
    return inputBlocks().filter((b) => prefillVars[b.variable_name] === undefined);
}


function renderProgress(block) {
    const askable = askableBlocks();
    const total = askable.length;
    const pos = askable.findIndex((b) => b.id === block?.id);
    const done = pos === -1
        ? askable.filter((b) => answersByBlock[b.id] !== undefined).length
        : pos;
    $("#fm-progress").innerHTML = Array.from({ length: total }, (_, i) =>
        `<span class="${i < done ? "done" : ""}"></span>`).join("");
    if (pos !== -1) {
        const pad = (n) => String(n).padStart(2, "0");
        $("#fm-printer-count").textContent = `${pad(pos + 1)} — ${pad(total)}`;
    }
    return { pos, total };
}

// ─── Botão principal (.bf-submit da página de captura) ───────────────────

const ARROW_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>`;

// tag "a" (CTA final, com href) ou "button"; icon é o conteúdo da bolha da direita
function submitButton({ label, action = "", type = "button", disabled = false, href = "", icon = ARROW_ICON }) {
    const inner = `
        <span class="fm-submit__glow" aria-hidden="true"><span></span></span>
        <span class="fm-submit__liquid" aria-hidden="true"></span>
        <span class="fm-submit__label">${label}</span>
        <span class="fm-submit__arrow" aria-hidden="true">${icon}</span>`;
    return href
        ? `<a class="fm-submit" href="${href}" target="_blank" rel="noopener">${inner}</a>`
        : `<button type="${type}" class="fm-submit" ${action ? `data-action="${action}"` : ""} ${disabled ? "disabled" : ""}>${inner}</button>`;
}

// ─── Telas ────────────────────────────────────────────────────────────────

function renderBlock(index) {
    const block = blocks[index];

    // Auto-pula blocos de input já pré-preenchidos (mesma regra do chat)
    if (INPUT_TYPES.includes(block.type) && block.variable_name && prefillVars[block.variable_name] !== undefined) {
        path.push({ i: index, shown: false });
        submitAnswer(prefillVars[block.variable_name], { silent: true });
        return;
    }
    path.push({ i: index, shown: true });
    saveSessionState();
    showScreen(block);
}

function showScreen(block) {
    busy = false;
    const { pos, total } = renderProgress(block);
    renderTicketFields();
    setActiveField(block.id);
    const canGoBack = path.slice(0, -1).some((p) => p.shown);

    const content = escHtml(interpolate(block.content || "", collectedVars));
    // Linha acima do título: seta de voltar (quando dá) + "Pergunta X de N"
    const backBtn = canGoBack ? `
        <button type="button" class="fm-back" data-action="back" aria-label="Voltar à pergunta anterior" title="Voltar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
        </button>` : "";
    const stepText = pos !== -1 ? `<span class="fm-step">Pergunta <b>${pos + 1}</b> de ${total}</span>` : "";
    const stepLabel = (backBtn || stepText) ? `<div class="fm-q-head">${backBtn}${stepText}</div>` : "";
    const previous = collectedVars[block.variable_name];
    let body = "";

    if (block.type === "message") {
        body = submitButton({ label: "Continuar", action: "next" });
    } else if (block.type === "single_choice" || block.type === "multiple_choice") {
        const multi = block.type === "multiple_choice";
        const picked = multi ? String(previous ?? "").split(", ") : [previous];
        const opts = (block.options || []).map((opt, i) => `
            <button type="button" class="fm-opt ${picked.includes(opt) ? "picked" : ""}" data-i="${i}"
                ${multi ? `aria-pressed="${picked.includes(opt)}"` : ""}>
                <kbd>${i < 9 ? i + 1 : ""}</kbd><span>${escHtml(opt)}</span>
            </button>`).join("");
        body = `
            <div class="fm-options ${multi ? "is-multi" : ""}" role="group" aria-label="${content}">${opts}</div>
            ${multi ? `<p class="fm-hint">Escolha uma ou mais opções.</p>
            ${submitButton({ label: "Confirmar", action: "confirm", disabled: !picked.filter(Boolean).length })}` : ""}`;
    } else {
        const kind = {
            email_input: { type: "email", mode: "email", ph: "seu@email.com", ac: "email" },
            phone_input: { type: "tel", mode: "tel", ph: "(11) 99999-9999", ac: "tel" },
        }[block.type] || { type: "text", mode: "text", ph: "Digite sua resposta...", ac: "off" };
        body = `
            <form class="fm-text-form" data-action="text" novalidate>
                <div class="fm-field">
                    <input id="fm-input" type="${kind.type}" inputmode="${kind.mode}" autocomplete="${kind.ac}"
                        placeholder="${kind.ph}" value="${escHtml(previous ?? "")}" aria-label="${content}"
                        aria-describedby="fm-input-error" />
                    <p class="fm-field-error" id="fm-input-error" role="alert" hidden></p>
                </div>
                ${submitButton({ label: "Continuar", type: "submit" })}
            </form>
            <p class="fm-hint fm-hint-keys">Ou pressione <b>Enter ↵</b></p>`;
    }

    qbox().innerHTML = `
        <div class="fm-q-enter">
            ${stepLabel}
            <h1 class="fm-question ${block.type === "message" ? "is-message" : ""}" tabindex="-1">${content}</h1>
            ${body}
        </div>`;

    wireScreen(block);
}

function wireScreen(block) {
    const box = qbox();
    const heading = box.querySelector(".fm-question");

    box.querySelector('[data-action="next"]')?.addEventListener("click", () => submitAnswer(null));
    box.querySelector('[data-action="back"]')?.addEventListener("click", goBack);

    if (block.type === "single_choice") {
        box.querySelectorAll(".fm-opt").forEach((btn) => {
            btn.addEventListener("click", () => pickSingle(block, Number(btn.dataset.i)));
        });
    }

    if (block.type === "multiple_choice") {
        const confirm = box.querySelector('[data-action="confirm"]');
        box.querySelectorAll(".fm-opt").forEach((btn) => {
            btn.addEventListener("click", () => {
                const on = btn.classList.toggle("picked");
                btn.setAttribute("aria-pressed", String(on));
                confirm.disabled = !box.querySelector(".fm-opt.picked");
            });
        });
        confirm.addEventListener("click", () => {
            const selected = [...box.querySelectorAll(".fm-opt.picked")].map((b) => block.options[Number(b.dataset.i)]);
            if (selected.length) submitAnswer(selected.join(", "));
        });
    }

    const input = box.querySelector("#fm-input");
    if (input) {
        if (block.type === "phone_input") applyPhoneMask(input);
        box.querySelector("form").addEventListener("submit", (e) => {
            e.preventDefault();
            submitText(block, input);
        });
        input.addEventListener("input", () => {
            input.removeAttribute("aria-invalid");
            $("#fm-input-error").hidden = true;
        });
        // Foco no campo sem rolar a página (no mobile o ingresso fica em cima)
        input.focus({ preventScroll: true });
    } else if (path.length > 1) {
        heading.focus({ preventScroll: true });
    }
}

function pickSingle(block, i) {
    if (busy) return;
    qbox().querySelectorAll(".fm-opt").forEach((b, j) => b.classList.toggle("picked", j === i));
    submitAnswer(block.options[i]);
}

function submitText(block, input) {
    if (busy) return;
    const val = input.value.trim();
    const error = $("#fm-input-error");
    if (!val || (block.type === "email_input" && !isValidEmail(val))) {
        // Mesmo padrão de erro do formulário da captura (.bf-field__error)
        input.setAttribute("aria-invalid", "true");
        error.textContent = val ? "Informe um e-mail válido." : "Responda para continuar.";
        error.hidden = false;
        input.focus();
        return;
    }
    submitAnswer(val);
}

// ─── Avanço ───────────────────────────────────────────────────────────────

async function submitAnswer(answer, { silent = false } = {}) {
    if (busy && !silent) return;
    busy = true;
    const block = blocks[currentIndex];

    if (answer !== null && block.variable_name) {
        collectedVars[block.variable_name] = answer;
        answersByBlock[block.id] = String(answer);
        const saving = apiPost("/public/sessions/answer", {
            session_id: sessionId,
            block_id: block.id,
            answer: String(answer),
        }).catch((e) => console.error("Erro ao salvar resposta:", e));
        pendingAnswers.add(saving);
        saving.finally(() => pendingAnswers.delete(saving));
    }

    const goNext = () => {
        const next = nextBlockIndex(blocks, currentIndex, block, answer);
        if (next >= blocks.length) { finishFlow(); return; }
        if (path.some((p) => p.i === next)) {
            console.error("Loop detectado no fluxo. Encerrando.");
            finishFlow();
            return;
        }
        currentIndex = next;
        renderBlock(currentIndex);
    };

    if (answer !== null && block.variable_name) {
        if (isPrintMode()) {
            setTicketValue(block.id, String(answer), false);
            if (!silent) printerPing();
            setTimeout(goNext, silent || reducedMotion ? 0 : 260); // tempo de ver a opção marcada
        } else {
            setTicketValue(block.id, String(answer), !silent, goNext);
        }
    } else {
        goNext();
    }
}

function goBack() {
    if (busy) return;
    // Remove a tela atual e qualquer bloco pulado por prefill até a tela anterior
    path.pop();
    while (path.length && !path[path.length - 1].shown) path.pop();
    const prev = path.pop();
    if (!prev) return;
    currentIndex = prev.i;
    renderBlock(currentIndex);
}

// ─── Final ────────────────────────────────────────────────────────────────

function calendarUrl(date) {
    const fmt = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const end = new Date(date.getTime() + 60 * 60 * 1000);
    const title = flowData.page_title?.trim() || flowData.name;
    return "https://calendar.google.com/calendar/render?action=TEMPLATE"
        + `&text=${encodeURIComponent(title)}`
        + `&dates=${fmt(date)}/${fmt(end)}`
        + `&details=${encodeURIComponent("O link é enviado no grupo do WhatsApp.")}`;
}

const wait = (ms) => new Promise((r) => setTimeout(r, reducedMotion ? 0 : ms));

// Selo de confirmação: círculo desenhado + check com overshoot + halos
// (mesma linguagem da sequência de sucesso do botão da página de captura)
const CONFIRM_MARK = `
    <div class="fm-confirm" aria-hidden="true">
        <span class="fm-confirm__halo"></span>
        <span class="fm-confirm__halo fm-confirm__halo--2"></span>
        <svg viewBox="0 0 80 80">
            <defs>
                <linearGradient id="fm-confirm-fill" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stop-color="#2caa98"/>
                    <stop offset=".55" stop-color="#0d9488"/>
                    <stop offset="1" stop-color="#0d5e57"/>
                </linearGradient>
            </defs>
            <circle class="fm-confirm__disc" cx="40" cy="40" r="34" fill="url(#fm-confirm-fill)"/>
            <circle class="fm-confirm__ring" cx="40" cy="40" r="37" pathLength="1"/>
            <path class="fm-confirm__check" d="M27 41.5 36 50 54 31" pathLength="1"/>
        </svg>
    </div>`;

// Holofote: escurece a página em volta do CTA (posição acompanha scroll/resize)
function spotlightOn(target) {
    const spot = document.createElement("div");
    spot.className = "fm-spotlight";
    spot.setAttribute("aria-hidden", "true");
    // Dentro do palco (que tem o próprio contexto de empilhamento): assim o CTA (z 16) fica por cima
    $("#fm-stage").appendChild(spot);
    let frame = null;
    const place = () => {
        frame = null;
        const r = target.getBoundingClientRect();
        spot.style.setProperty("--sx", `${r.left + r.width / 2}px`);
        spot.style.setProperty("--sy", `${r.top + r.height / 2}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
    place();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    requestAnimationFrame(() => spot.classList.add("is-on"));
}

// ─── Terminal de emissão (flow_type "form_print") ────────────────────────
// Mesma lógica do protótipo: o terminal recebe as respostas e, no final,
// processa e "imprime" o ingresso (que sai pela fenda).

const PRINT_MS = 3000;
const isPrintMode = () => flowData?.flow_type === "form_print";

function setPrinter(state, label) {
    const printer = $("#fm-printer");
    printer.classList.remove("is-receiving", "is-processing", "is-printing", "is-ready");
    if (state) printer.classList.add(`is-${state}`);
    if (label) $("#fm-printer-status").textContent = label;
}

// Pisca o LED a cada resposta recebida
function printerPing() {
    setPrinter("receiving", "Recebendo respostas");
    clearTimeout(printerPing.t);
    printerPing.t = setTimeout(() => $("#fm-printer").classList.remove("is-receiving"), 380);
}

// Emissão: com WebGL (js/ticket-cloth.js, carregado só neste modo) o papel sai da
// fenda e flamula como tecido; sem WebGL, com falha ou em aparelho lento, o papel
// simplesmente desce pela fenda e fica parado (fallback estático).
function printTicket() {
    const feed = $("#fm-feed");
    const el = $("#fm-ticket");
    const showStatic = () => {
        feed.classList.remove("has-cloth");
        el.classList.remove("is-cloth-source");
        feed.style.transition = "";
        feed.style.height = "auto";
        feed.classList.add("is-open");
    };
    if (reducedMotion) { showStatic(); return Promise.resolve(); }

    if (window.TicketCloth?.supported()) {
        feed.style.height = `${el.offsetHeight}px`;
        feed.classList.add("is-feeding");
        return window.TicketCloth.print({ feed, ticket: el, durationMs: PRINT_MS, onFail: showStatic })
            .then(() => { feed.classList.remove("is-feeding"); feed.classList.add("is-open"); })
            .catch((e) => { console.warn("Ingresso em tecido desativado:", e); showStatic(); });
    }

    // Fallback: o papel desce pela fenda (altura animada), sem física
    return new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; showStatic(); resolve(); };
        feed.style.height = "0px";
        requestAnimationFrame(() => {
            feed.style.transition = `height ${PRINT_MS}ms cubic-bezier(.33, 1, .68, 1)`;
            feed.style.height = `${el.offsetHeight}px`;
        });
        feed.addEventListener("transitionend", finish, { once: true });
        setTimeout(finish, PRINT_MS + 800);
    });
}

async function finishFlow() {
    busy = true;
    clearSessionState();

    // 1) Saída da última pergunta enquanto a sessão é concluída no servidor
    qbox().firstElementChild?.classList.add("fm-q-exit");
    // Wait for answer upserts before resolving the final CTA.
    await Promise.all([...pendingAnswers]);
    const [res] = await Promise.all([
        apiPost("/public/sessions/complete", { session_id: sessionId })
            .catch((e) => { console.error("Erro ao completar:", e); return {}; }),
        wait(350),
    ]);
    const whatsappLink = res.whatsapp_link || null;

    document.querySelectorAll("#fm-progress span").forEach((s) => s.classList.add("done"));
    renderTicketFields({ onlyWalked: true });
    setActiveField(null);
    document.title = document.title.replace("Finalizando inscrição", "Inscrição confirmada");
    $("#fm-intro").hidden = true;
    $("#fm-progress").hidden = true;

    const behavior = flowData.pure_end_behavior || "card_done";
    const redirectUrl = `${API}/public/sessions/${sessionId}/redirect`;
    const message = flowData.final_message?.trim()
        || "Suas respostas foram registradas. Agora é só entrar no grupo para receber a oferta.";
    const btnLabel = flowData.button_text?.trim() || "Entrar no grupo do WhatsApp";
    const date = parseCountdown(flowData.countdown_date);
    const showCta = whatsappLink && (behavior === "card_done" || behavior === "whatsapp_button");

    let actions = "";
    if (showCta) {
        actions = submitButton({ label: escHtml(btnLabel), href: redirectUrl, icon: '<i class="fa-brands fa-whatsapp"></i>' });
    } else if (behavior === "bot_message_redirect" && whatsappLink) {
        actions = `<p class="fm-hint">Redirecionando…</p>`;
    } else if (!whatsappLink && behavior !== "bot_message") {
        actions = `<p class="fm-hint">Fique de olho no seu e-mail para mais informações.</p>`;
    }
    if (date && date > new Date()) {
        actions += `<a class="fm-secondary" href="${calendarUrl(date)}" target="_blank" rel="noopener">Salvar na minha agenda</a>`;
    }

    // 1b) Modo emissão: o terminal processa e imprime o ingresso antes da confirmação
    const printing = isPrintMode();
    if (printing) {
        qbox().innerHTML = `
            <div class="fm-final">
                <p class="fm-final-kicker is-live">Emitindo seu ingresso</p>
                <h1 class="fm-question" tabindex="-1">Seu ingresso está saindo.</h1>
                <p class="fm-final-text">Estamos imprimindo os detalhes da sua inscrição.</p>
            </div>`;
        qbox().querySelector("h1").focus({ preventScroll: true });
        $("#fm-printer-count").textContent = "Concluído";
        // No celular o terminal fica abaixo das perguntas: leva a pessoa até ele
        if (window.matchMedia("(max-width: 880px)").matches) {
            $("#fm-printer").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
        }
        setPrinter("processing", "Processando");
        // "fotografa" o ingresso para o papel-tecido enquanto o terminal processa,
        // antes de qualquer mudança na tela (sem pulo/piscada na hora de imprimir)
        if (!reducedMotion && window.TicketCloth?.supported()) window.TicketCloth.prepare($("#fm-ticket"));
        await wait(700);
        setPrinter("printing", "Emitindo");
        await printTicket();
        setPrinter("ready", "Ingresso emitido");
        await wait(250);
    }

    // 2) Selo + títulos entram em sequência (atrasos no CSS)
    document.body.classList.add("fm-is-done");
    qbox().innerHTML = `
        <div class="fm-final">
            ${CONFIRM_MARK}
            <p class="fm-final-kicker">Inscrição confirmada</p>
            <h1 class="fm-question" tabindex="-1">${printing ? "Seu ingresso foi emitido." : "Seu ingresso está pronto."}</h1>
            <p class="fm-final-text">${escHtml(interpolate(message, collectedVars))}</p>
            ${actions ? `<div class="fm-final-actions ${showCta ? "has-cta" : ""}">${actions}</div>` : ""}
        </div>`;
    qbox().querySelector("h1").focus({ preventScroll: true });
    // No celular o form fica em cima do ingresso: volta ao topo para ver selo + carimbo
    // (no modo emissão a pessoa continua olhando o ingresso que acabou de sair)
    if (!printing && window.matchMedia("(max-width: 880px)").matches) {
        window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
    }
    if (behavior === "bot_message_redirect" && whatsappLink) {
        setTimeout(() => { window.location.href = redirectUrl; }, 2600);
    }

    // 3) Carimbo no ingresso logo depois do check
    await wait(750);
    document.querySelectorAll(".fm-ticket").forEach((t) => t.classList.add("done")); // original + faixas do papel-tecido
    await wait(620);
    // vibração só depois de um toque (o navegador bloqueia e reclama no console)
    if (navigator.userActivation?.hasBeenActive) { try { navigator.vibrate?.(14); } catch (_) {} }
    window.TicketCloth?.stamp(); // no papel-tecido o carimbo é desenhado na malha e faz o papel ondular

    // 4) Foco total no CTA
    const cta = qbox().querySelector(".fm-final-actions.has-cta .fm-submit");
    if (cta) {
        await wait(450);
        spotlightOn(cta);
    }
}

// ─── Brilho do ingresso ───────────────────────────────────────────────────
// Só com mouse: o brilho acompanha o cursor (2D, sem tilt).

if (window.matchMedia("(hover: hover) and (pointer: fine)").matches && !reducedMotion) {
    let frame = null;
    document.addEventListener("pointermove", (e) => {
        const ticket = $("#fm-ticket");
        if (!ticket || frame || isPrintMode()) return; // no modo emissão a luz vem da física do papel
        frame = requestAnimationFrame(() => {
            frame = null;
            // Relativo à janela: a pessoa passa o tempo respondendo à esquerda,
            // e o ingresso ainda reage (sutil) ao movimento
            const x = e.clientX / window.innerWidth;
            const y = e.clientY / window.innerHeight;
            ticket.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
            ticket.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
        });
    });
}

// ─── Teclado ──────────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
    if (busy || e.metaKey || e.ctrlKey || e.altKey) return;
    const block = blocks[currentIndex];
    if (!block || e.target.tagName === "INPUT") return;

    if (block.type === "single_choice" || block.type === "multiple_choice") {
        const n = parseInt(e.key, 10);
        const btn = qbox().querySelectorAll(".fm-opt")[n - 1];
        if (n >= 1 && btn) { e.preventDefault(); btn.click(); return; }
    }
    if (e.key === "Enter" && e.target.tagName !== "BUTTON") {
        const action = qbox().querySelector('[data-action="next"], [data-action="confirm"]:not(:disabled)');
        if (action) { e.preventDefault(); action.click(); }
    }
});

// ─── Init ─────────────────────────────────────────────────────────────────

function showError() {
    $("#fm-loading").classList.add("hidden");
    $("#fm-error").classList.remove("hidden");
}

document.addEventListener("DOMContentLoaded", async () => {
    prefillVars = getPrefillParams();
    collectedVars = { ...prefillVars };

    const slug = window.location.pathname.split("/f/")[1]?.split("/")[0];
    if (!slug) { showError(); return; }
    currentSlug = slug;

    try {
        const res = await fetch(`${API}/public/f/${slug}`);
        if (!res.ok) { showError(); return; }
        flowData = await res.json();
        blocks = flowData.blocks.filter((b) => b.is_active !== false);
        if (isPrintMode()) {
            document.body.classList.add("fm-mode-print");
            // módulo do papel-tecido (WebGL): só neste modo, carregado enquanto a pessoa responde
            const script = document.createElement("script");
            script.src = "/js/ticket-cloth.js?v=9";
            script.async = true;
            document.head.appendChild(script);
        }
        if (!blocks.length) { showError(); return; }

        if (flowData.page_title) document.title = `${flowData.page_title} — Asimov`;
        // Sem texto próprio, a introdução diz quantas perguntas faltam — expectativa curta ajuda a completar
        const askable = askableBlocks().length;
        const questions = askable === 1 ? "1 pergunta rápida" : `${askable} perguntas rápidas`;
        const intro = flowData.page_subtitle?.trim()
            || (!askable ? ""
                : isPrintMode() ? `Falta só um passo: responda ${questions} e emita seu ingresso para a live.`
                : `Falta só um passo: responda ${questions} para finalizar sua inscrição.`);
        if (intro) {
            $("#fm-intro").textContent = intro;
            $("#fm-intro").hidden = false;
        }

        // Retoma sessão em andamento (se houver)
        let resumed = false;
        try {
            const state = JSON.parse(localStorage.getItem(`typebot_session_${slug}`) || "null");
            if (state?.sessionId && state.currentIndex != null && state.currentIndex < blocks.length) {
                sessionId = state.sessionId;
                currentIndex = state.currentIndex;
                collectedVars = { ...prefillVars, ...(state.collectedVars || {}) };
                path = Array.isArray(state.path) ? state.path.filter((p) => p.i !== currentIndex) : [];
                answersByBlock = state.answersByBlock || {};
                resumed = true;
            }
        } catch (_) {
            localStorage.removeItem(`typebot_session_${slug}`);
        }

        if (!resumed) {
            const session = await apiPost("/public/sessions", {
                flow_id: flowData.id,
                meta: getUtmParams(),
                prefill: Object.keys(prefillVars).length ? prefillVars : null,
            });
            sessionId = session.session_id;
        }

        renderTicket();
        $("#fm-loading").classList.add("hidden");
        $("#fm-stage").classList.remove("hidden");
        renderBlock(currentIndex);
    } catch (e) {
        console.error(e);
        showError();
    }
});
