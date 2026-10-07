// Papel-tecido em WebGL2 para o modo emissão (flow_type "form_print").
// Carregado só nesse modo. O ingresso do DOM é "fotografado" num canvas 2D (posições
// lidas da própria página, então fica idêntico) e desenhado como tecido.
//
// A simulação (campo de alturas com equação de onda), os shaders de tecido/sombra e
// os parâmetros são adaptados do componente Cloth do Canvas UI
// (https://canvasui.dev/docs/components/cloth) — Copyright (c) 2026 David Haz,
// MIT + Commons Clause; licença completa em ticket-cloth.LICENSE.md. A diferença é a
// origem da textura: o Canvas UI usa o recurso experimental html-in-canvas; aqui a
// textura vem do nosso próprio "pintor", para funcionar em qualquer navegador com WebGL2.
//
// Se não houver WebGL2, se algo falhar ou se o aparelho não sustentar o desempenho,
// quem chama cai no ingresso estático.
//
// API: window.TicketCloth = { supported(), prepare(ticket), print({...}), stamp(), gust(n) }

(() => {
    // ─── Suporte ──────────────────────────────────────────────────────────

    function supported() {
        try {
            const c = document.createElement("canvas");
            return !!c.getContext("webgl2", { failIfMajorPerformanceCaveat: true });
        } catch (_) {
            return false;
        }
    }

    // ─── "Foto" do ingresso num canvas 2D ────────────────────────────────

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
        });
    }

    function hexToRgb(hex) {
        const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
        return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [3, 16, 14];
    }

    function tinted(img, w, h, color) {
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w));
        c.height = Math.max(1, Math.round(h));
        const x = c.getContext("2d");
        x.drawImage(img, 0, 0, c.width, c.height);
        x.globalCompositeOperation = "source-in";
        x.fillStyle = color;
        x.fillRect(0, 0, c.width, c.height);
        return c;
    }

    function makeNoise(size, alpha) {
        const c = document.createElement("canvas");
        c.width = c.height = size;
        const x = c.getContext("2d");
        const data = x.createImageData(size, size);
        for (let i = 0; i < data.data.length; i += 4) {
            data.data[i] = data.data[i + 1] = data.data[i + 2] = 0;
            data.data[i + 3] = Math.random() * 255 * alpha;
        }
        x.putImageData(data, 0, 0);
        return c;
    }

    // Opacidade acumulada do elemento até o ingresso (exclusive)
    function opacityOf(el, root) {
        let a = 1;
        for (let n = el; n && n !== root; n = n.parentElement) a *= parseFloat(getComputedStyle(n).opacity) || 0;
        return a;
    }

    // Desenha o texto de um elemento palavra por palavra, na posição exata em que
    // a página o desenhou (Range.getClientRects), com a fonte/cor/caixa computadas.
    function paintText(ctx, el, origin, root, { shadow = null } = {}) {
        const box = el.getBoundingClientRect();
        if (!box.width || !box.height) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(box.left - origin.left - 2, box.top - origin.top - 2, box.width + 4, box.height + 4);
        ctx.clip();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        let last = null;
        let clipped = false;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.textContent;
            if (!text.trim()) continue;
            const parent = node.parentElement;
            const st = getComputedStyle(parent);
            ctx.font = `${st.fontStyle} ${st.fontWeight} ${st.fontSize} ${st.fontFamily}`;
            if ("letterSpacing" in ctx) ctx.letterSpacing = st.letterSpacing === "normal" ? "0px" : st.letterSpacing;
            ctx.fillStyle = st.color;
            const alpha = opacityOf(parent, root);
            const metrics = ctx.measureText("Hg");
            const ascent = metrics.fontBoundingBoxAscent ?? parseFloat(st.fontSize) * 0.93;
            const upper = st.textTransform === "uppercase";
            const re = /\S+/g;
            for (let m = re.exec(text); m; m = re.exec(text)) {
                range.setStart(node, m.index);
                range.setEnd(node, m.index + m[0].length);
                const r = range.getClientRects()[0];
                if (!r) continue;
                const word = upper ? m[0].toUpperCase() : m[0];
                const x = r.left - origin.left;
                const y = r.top - origin.top + ascent;
                if (r.top >= box.bottom - 1) { clipped = true; continue; } // além do line-clamp
                if (shadow) {
                    ctx.globalAlpha = alpha * shadow.alpha;
                    const f = ctx.fillStyle;
                    ctx.fillStyle = shadow.color;
                    ctx.fillText(word, x, y + shadow.dy);
                    ctx.fillStyle = f;
                }
                ctx.globalAlpha = alpha;
                ctx.fillText(word, x, y);
                last = { x: r.right - origin.left, y, alpha };
            }
        }
        if (clipped && last) { ctx.globalAlpha = last.alpha; ctx.fillText("…", last.x, last.y); }
        ctx.restore();
    }

    function roundRectPath(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    // Fundo do ingresso (mesmas camadas do CSS de .fm-ticket)
    function paintBackground(ctx, W, H, v, ink) {
        const a = (158 * Math.PI) / 180;
        const dx = Math.sin(a), dy = -Math.cos(a);
        const len = Math.abs(W * dx) + Math.abs(H * dy);
        const g = ctx.createLinearGradient(W / 2 - (dx * len) / 2, H / 2 - (dy * len) / 2, W / 2 + (dx * len) / 2, H / 2 + (dy * len) / 2);
        g.addColorStop(0, v("--ui-accent-glow"));
        g.addColorStop(0.28, v("--ui-accent-light"));
        g.addColorStop(0.62, v("--ui-accent"));
        g.addColorStop(1, v("--ui-accent-dark"));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        const radial = (cx, cy, rx, ry, color, stop) => {
            ctx.save();
            ctx.translate(cx, cy);
            ctx.scale(rx, ry);
            const r = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
            r.addColorStop(0, color);
            r.addColorStop(stop, "rgba(0,0,0,0)");
            ctx.fillStyle = r;
            ctx.fillRect(-cx / rx, -cy / ry, W / rx, H / ry);
            ctx.restore();
        };
        radial(0, 0, W * 1.2, H * 0.8, "rgba(255,255,255,.42)", 0.52);
        radial(W, H, W * 0.9, H * 0.7, `rgba(${ink},.22)`, 0.62);
        // brilho interno na base (inset 0 -40px 60px -40px)
        const b = ctx.createLinearGradient(0, H - 40, 0, H);
        b.addColorStop(0, "rgba(0,0,0,0)");
        b.addColorStop(1, `rgba(${ink},.16)`);
        ctx.fillStyle = b;
        ctx.fillRect(0, H - 40, W, 40);
    }

    async function snapshot(ticket, dpr) {
        if (document.fonts?.ready) await document.fonts.ready;
        const [logo, guilloche] = await Promise.all([
            loadImage("/ds/asimov-logo.svg"),
            loadImage("/img/ticket-guilloche.svg"),
        ]);
        const origin = ticket.getBoundingClientRect();
        const W = origin.width, H = origin.height;
        const st = getComputedStyle(ticket);
        const v = (name) => st.getPropertyValue(name).trim();
        const inkHex = v("--fm-ink") || "#03100e";
        const inkRgb = hexToRgb(inkHex);
        const ink = inkRgb.join(",");
        const inkVec = inkRgb.map((n) => n / 255);
        const hero = parseFloat(v("--hero")) || 290;
        const notch = parseFloat(v("--notch")) || 16;
        const radius = parseFloat(st.borderTopLeftRadius) || 24;
        const rel = (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
        };
        const q = (sel) => ticket.querySelector(sel);

        const canvas = document.createElement("canvas");
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        const ctx = canvas.getContext("2d");
        ctx.scale(dpr, dpr);

        const heroEl = q(".fm-t-hero");
        const heroRect = heroEl ? rel(heroEl) : null;
        const paintBase = () => {
            paintBackground(ctx, W, H, v, ink);
            // ondas finas (guilhoché) no topo
            if (heroRect) {
                const r = heroRect;
                const gh = r.w * (guilloche.height / guilloche.width);
                ctx.drawImage(tinted(guilloche, r.w * dpr, gh * dpr, inkHex), r.x, r.y + (r.h - gh) * 0.3, r.w, gh);
            }
        };
        const grain = makeNoise(160, 0.9);
        const paintGrain = () => {
            ctx.save();
            ctx.globalAlpha = 0.13;
            ctx.fillStyle = ctx.createPattern(grain, "repeat");
            ctx.fillRect(0, 0, W, H);
            ctx.restore();
        };

        paintBase();

        // logo Asimov (máscara pintada na tinta)
        const logoEl = q(".fm-t-logo");
        if (logoEl) {
            const r = rel(logoEl);
            const s = Math.min(r.w / logo.width, r.h / logo.height);
            const w = logo.width * s, h = logo.height * s;
            ctx.drawImage(tinted(logo, w * dpr, h * dpr, inkHex), r.x, r.y + (r.h - h) / 2, w, h);
        }
        // pílula do número
        const num = q(".fm-t-num");
        if (num) {
            const r = rel(num);
            ctx.strokeStyle = `rgba(${ink},.3)`;
            ctx.lineWidth = 1;
            roundRectPath(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, r.h / 2);
            ctx.stroke();
        }
        // lettering Black Friday com as duas sombras do CSS
        const bf = q(".fm-t-logo-bf");
        if (bf && bf.complete && bf.naturalWidth) {
            const r = rel(bf);
            ctx.save();
            ctx.shadowColor = `rgba(${ink},.25)`; ctx.shadowBlur = 18; ctx.shadowOffsetY = 10;
            ctx.drawImage(bf, r.x, r.y, r.w, r.h);
            ctx.shadowColor = `rgba(${ink},.35)`; ctx.shadowBlur = 2; ctx.shadowOffsetY = 2;
            ctx.drawImage(bf, r.x, r.y, r.w, r.h);
            ctx.restore();
        }
        // divisórias (border-top das grades e do rodapé)
        ticket.querySelectorAll(".fm-t-grid, .fm-t-foot").forEach((el) => {
            const cs = getComputedStyle(el);
            const bw = parseFloat(cs.borderTopWidth);
            if (!bw || cs.borderTopStyle === "none" || !el.getClientRects().length) return;
            const r = rel(el);
            ctx.save();
            ctx.strokeStyle = cs.borderTopColor;
            ctx.lineWidth = bw;
            if (cs.borderTopStyle === "dashed") ctx.setLineDash([bw * 3, bw * 2.4]);
            ctx.beginPath();
            ctx.moveTo(r.x, r.y + bw / 2);
            ctx.lineTo(r.x + r.w, r.y + bw / 2);
            ctx.stroke();
            ctx.restore();
        });
        // picote
        const perf = q(".fm-t-perf");
        if (perf) {
            const r = rel(perf);
            ctx.fillStyle = `rgba(${ink},.5)`;
            for (let x = r.x + 4.5; x < r.x + r.w; x += 9) {
                ctx.beginPath();
                ctx.arc(x, r.y + r.h / 2, 1.6, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        // textos
        const textSel = ".fm-t-num, .fm-t-subtitle, .fm-t-label, .fm-t-value, .fm-t-count";
        ticket.querySelectorAll(textSel).forEach((el) => {
            if (el.closest(".fm-stamp")) return;
            paintText(ctx, el, origin, ticket);
        });
        const code = q(".fm-t-code");
        if (code) paintText(ctx, code, origin, ticket, { shadow: { color: "rgba(255,255,255,1)", alpha: 0.35, dy: 1 } });

        paintGrain();
        // brilho do papel (.fm-t-glare: radial branco em soft-light, ~30% 0%)
        ctx.save();
        const glare = ctx.createRadialGradient(W * 0.3, 0, 0, W * 0.3, 0, Math.hypot(W, H) * 0.42);
        glare.addColorStop(0, "rgba(255,255,255,.2)");
        glare.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = glare;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
        // bordas: brilho na aresta de cima + contorno claro
        ctx.save();
        roundRectPath(ctx, 0.5, 0.5, W - 1, H - 1, radius);
        ctx.strokeStyle = "rgba(255,255,255,.16)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(radius, 1);
        ctx.lineTo(W - radius, 1);
        ctx.strokeStyle = "rgba(255,255,255,.6)";
        ctx.stroke();
        ctx.restore();
        // recorte: cantos arredondados + entalhes na linha do picote
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#000"; // opaco: o recorte não pode herdar a cor/alpha do último desenho
        ctx.globalCompositeOperation = "destination-in";
        roundRectPath(ctx, 0, 0, W, H, radius);
        ctx.fill();
        ctx.globalCompositeOperation = "destination-out";
        for (const x of [0, W]) {
            ctx.beginPath();
            ctx.arc(x, hero, notch, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();

        // Redesenha só a área do contador (a cada segundo)
        const countEl = q(".fm-t-count");
        const countRect = countEl ? rel(countEl) : null;
        const repaintCount = () => {
            if (!countEl) return null;
            const r = countRect;
            // A textura mantém as posições da foto, mesmo se a confirmação ou a
            // rolagem moverem o ingresso na página depois da emissão.
            const current = countEl.getBoundingClientRect();
            const countOrigin = { left: current.left - r.x, top: current.top - r.y };
            const pad = 4;
            const box = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), w: Math.min(W, r.w + pad * 2 + 30), h: r.h + pad * 2 };
            ctx.save();
            ctx.beginPath();
            ctx.rect(box.x, box.y, box.w, box.h);
            ctx.clip();
            paintBase();
            paintText(ctx, countEl, countOrigin, ticket);
            paintGrain();
            ctx.restore();
            return box;
        };

        // Carimbo: sprite separado (anima no shader, deforma junto com o papel)
        const stampEl = q(".fm-stamp");
        let stamp = null;
        if (stampEl) {
            const size = stampEl.offsetWidth;
            const cx = stampEl.offsetLeft + size / 2;
            const cy = stampEl.offsetTop + stampEl.offsetHeight / 2;
            stamp = { cx, cy, size, canvas: paintStamp(stampEl, size, dpr * 2, inkHex) };
        }

        return { canvas, ctx, W, H, repaintCount, stamp, ink: inkVec, radius };
    }

    function paintStamp(stampEl, size, scale, inkHex) {
        const c = document.createElement("canvas");
        c.width = c.height = Math.round(size * scale);
        const x = c.getContext("2d");
        x.scale(scale, scale);
        const cs = getComputedStyle(stampEl);
        x.strokeStyle = x.fillStyle = inkHex;
        x.lineWidth = 3;
        x.beginPath();
        x.arc(size / 2, size / 2, size / 2 - 1.5, 0, Math.PI * 2);
        x.stroke();
        x.lineWidth = 1.5;
        x.setLineDash([3, 2.2]);
        x.beginPath();
        x.arc(size / 2, size / 2, size / 2 - 7.5, 0, Math.PI * 2);
        x.stroke();
        x.setLineDash([]);
        const fs = parseFloat(cs.fontSize) || 16;
        x.textAlign = "center";
        x.textBaseline = "middle";
        x.font = `700 ${fs}px ${cs.fontFamily}`;
        if ("letterSpacing" in x) x.letterSpacing = `${fs * 0.02}px`;
        x.fillText("VAGA", size / 2, size / 2 - fs * 0.62);
        x.fillText("GARANTIDA", size / 2, size / 2 + fs * 0.42);
        const small = stampEl.querySelector("small");
        if (small && small.textContent.trim()) {
            x.font = `500 ${Math.max(9, fs * 0.6)}px ui-monospace, Menlo, monospace`;
            if ("letterSpacing" in x) x.letterSpacing = "0px";
            x.fillText(small.textContent.trim(), size / 2, size / 2 + fs * 1.45);
        }
        // tinta falhada: apaga manchas com ruído de baixa frequência
        const n = document.createElement("canvas");
        n.width = n.height = 28;
        const nx = n.getContext("2d");
        const nd = nx.createImageData(28, 28);
        for (let i = 0; i < nd.data.length; i += 4) nd.data[i + 3] = Math.random() * 255;
        nx.putImageData(nd, 0, 0);
        const big = document.createElement("canvas");
        big.width = big.height = c.width;
        const bx = big.getContext("2d");
        bx.imageSmoothingEnabled = true;
        bx.drawImage(n, 0, 0, big.width, big.height);
        const mask = bx.getImageData(0, 0, big.width, big.height).data;
        const img = x.getImageData(0, 0, c.width, c.height);
        for (let i = 3; i < img.data.length; i += 4) {
            const erase = Math.min(1, Math.max(0, (mask[i] / 255 - 0.66) * 4));
            img.data[i] *= 1 - erase;
        }
        x.putImageData(img, 0, 0);
        return c;
    }

    // ─── Motor de tecido (adaptado do Canvas UI Cloth) ───────────────────

    const CFG = {
        wind: 2.6,          // força do vento
        speed: 0.5,         // velocidade do movimento
        amplitude: 22,      // altura das dobras (px)
        drape: 12,          // quanto o papel "enche" para a frente longe do topo (px)
        brush: 2.05,        // força da onda que o cursor/dedo cria
        brushSize: 140,     // raio do cursor (px)
        damping: 1,         // quão rápido as ondas acalmam
        light: 0.45,        // luz nas dobras (0–1)
        sheen: 0.12,        // brilho nas cristas (0–1)
        shadow: 0.28,       // sombra de contato (0–1)
        perspective: 1200,  // distância focal (px)
    };
    const SEG = 96;
    const NODES = SEG + 1;
    const DT = 1 / 120;
    const WAVE_SPEED = 30;
    const STIFFNESS = 0.55;
    const FORCE_GAIN = 5.0;
    const BLEED = 48;       // folga do canvas para as dobras e a sombra
    const FIRM = 70;        // px logo abaixo da fenda/topo em que o papel fica firme
    const MIN_FPS = 38;     // abaixo disso desiste e mostra o ingresso estático

    const CLOTH_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aGrid;
layout(location = 1) in vec4 aData;
layout(location = 2) in vec2 aOffset;
uniform vec2 uRes;
uniform vec2 uOut;
uniform float uBleed;
uniform float uFocal;
uniform float uShift;
out vec2 vUv;
out vec3 vNormal;
out float vFold;
out vec2 vLocal;
void main () {
  vUv = aGrid;
  float z = aData.x;
  vec2 nxy = aData.yz;
  vNormal = vec3(nxy, sqrt(max(1.0 - dot(nxy, nxy), 0.04)));
  vFold = aData.w;
  vLocal = aGrid * uRes;
  vec2 px = vLocal + aOffset + vec2(uBleed) + vec2(0.0, uShift);
  vec2 ndc = (px / uOut) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  float w = (uFocal - z) / uFocal;
  gl_Position = vec4(ndc, -z / uFocal, w);
}`;

    const SDF = `
float fabricDist (vec2 p, vec2 size, float radius) {
  vec2 half_ = size * 0.5;
  float r = min(radius, min(half_.x, half_.y));
  vec2 q = abs(p - half_) - (half_ - vec2(r));
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}`;

    const CLOTH_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
in vec3 vNormal;
in float vFold;
in vec2 vLocal;
out vec4 outColor;
uniform sampler2D uContent;
uniform sampler2D uStamp;
uniform float uLight;
uniform float uSheen;
uniform vec2 uRes;
uniform float uRadius;
uniform vec2 uStampC;
uniform float uStampSize;
uniform float uStampScale;
uniform float uStampAlpha;
uniform vec3 uInk;
${SDF}
void main () {
  vec2 uv = clamp(vUv, vec2(0.001), vec2(0.999));
  vec4 tex = texture(uContent, uv);
  if (tex.a < 0.004) discard;
  vec3 fabric = tex.rgb;
  // carimbo: sprite girado -16°, multiplicado na tinta (deforma junto com o papel)
  if (uStampAlpha > 0.0) {
    vec2 d = vLocal - uStampC;
    vec2 q = vec2(d.x * 0.9613 - d.y * 0.2756, d.x * 0.2756 + d.y * 0.9613) / (uStampSize * uStampScale) + 0.5;
    if (q.x > 0.0 && q.x < 1.0 && q.y > 0.0 && q.y < 1.0) {
      float a = texture(uStamp, q).a * uStampAlpha;
      fabric *= mix(vec3(1.0), uInk, a);
    }
  }
  vec3 n = normalize(vNormal);
  vec3 lightDir = normalize(vec3(-0.3, 0.42, 0.86));
  float diffFlat = 0.58 + 0.42 * lightDir.z;
  float diff = 0.58 + 0.42 * dot(n, lightDir);
  float shade = mix(1.0, (diff / diffFlat) * vFold, uLight);
  vec3 lit = fabric * shade;
  vec3 halfway = normalize(lightDir + vec3(0.0, 0.0, 1.0));
  float specFlat = pow(halfway.z, 34.0);
  float spec = max(pow(max(dot(n, halfway), 0.0), 34.0) - specFlat, 0.0) / (1.0 - specFlat);
  lit += uSheen * spec * mix(vec3(1.0), fabric, 0.35);
  float dist = fabricDist(vLocal, uRes, uRadius);
  float hemT = smoothstep(0.0, 6.0, -dist);
  lit *= mix(1.0, mix(0.93, 1.0, hemT), uLight);
  float alpha = clamp(0.5 - dist, 0.0, 1.0) * tex.a;
  outColor = vec4(clamp(lit, 0.0, 1.0), 1.0) * alpha;
}`;

    const SHADOW_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aGrid;
layout(location = 1) in vec4 aData;
layout(location = 2) in vec2 aOffset;
uniform vec2 uRes;
uniform vec2 uOut;
uniform float uBleed;
uniform float uShift;
out vec2 vLocal;
out float vLift;
void main () {
  float z = aData.x;
  vLift = z;
  vLocal = aGrid * uRes;
  vec2 px = vLocal + aOffset + vec2(uBleed) + vec2(0.0, uShift) + vec2(10.0, 14.0) + vec2(0.3, 0.42) * z;
  vec2 ndc = (px / uOut) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;

    const SHADOW_FRAG = `#version 300 es
precision highp float;
in vec2 vLocal;
in float vLift;
out vec4 outColor;
uniform float uShadow;
uniform vec2 uRes;
uniform float uRadius;
${SDF}
void main () {
  float d = fabricDist(vLocal, uRes, uRadius);
  float a = uShadow * smoothstep(0.0, 30.0, -d);
  a *= mix(1.0, 0.55, clamp(vLift / 50.0, 0.0, 1.0));
  outColor = vec4(0.0, 0.0, 0.0, a);
}`;

    const S = {
        gl: null, canvas: null, feed: null, ticket: null, snap: null, prep: null,
        W: 1, H: 1, dpr: 1,
        out: 0, freeAll: false,
        running: false, visible: true, raf: 0, last: 0, debt: 0,
        frames: 0, frameTime: 0, onFail: null, countTimer: 0,
        stampT: -1, pressed: false,
    };

    function compile(gl, type, text) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, text);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        return sh;
    }

    function link(gl, vert, frag) {
        const program = gl.createProgram();
        gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vert));
        gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, frag));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        const uniforms = {};
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i++) {
            const info = gl.getActiveUniform(program, i);
            uniforms[info.name] = gl.getUniformLocation(program, info.name);
        }
        return { program, uniforms };
    }

    function makeTexture(gl, source) {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); // o shader multiplica pelo alpha
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
    }

    // Estado da simulação
    let hCur = new Float32Array(NODES * NODES);
    let hPrev = new Float32Array(NODES * NODES);
    let hNext = new Float32Array(NODES * NODES);
    const vertexData = new Float32Array(NODES * NODES * 4);
    const offsetData = new Float32Array(NODES * NODES * 2);
    const zField = new Float32Array(NODES * NODES);
    const rowForce = new Float32Array(NODES);
    const colForce = new Float32Array(NODES);
    const hangCurve = new Float32Array(NODES);
    for (let a = 0; a < NODES; a++) hangCurve[a] = Math.pow(a / SEG, 1.3);
    let simTime = Math.random() * 60;
    let gust = 0.5;
    let gustBoost = 0;
    const pointer = { x: -1e5, y: -1e5, inside: false };
    const touch = { x: -1e5, y: -1e5, vx: 0, vy: 0, s: 0 };

    function stepSim(dt) {
        simTime += dt * CFG.speed;
        const t = simTime;
        const windAmp = FORCE_GAIN * CFG.wind * (gust + gustBoost);
        const kb1 = (Math.PI * 2) / (SEG / 1.5);
        const kb2 = (Math.PI * 2) / (SEG / 3.8);
        const ka = (Math.PI * 2) / (SEG / 2.2);
        const w1 = WAVE_SPEED * kb1, w2 = WAVE_SPEED * kb2;
        const drift = 1.8 * Math.sin(0.23 * t);
        for (let b = 0; b < NODES; b++) {
            rowForce[b] = Math.sin(kb1 * b - w1 * t + drift) + 0.45 * Math.sin(kb2 * b + w2 * t * 0.8 + 3.0);
        }
        for (let a = 0; a < NODES; a++) colForce[a] = (0.7 + 0.3 * Math.sin(ka * a - 1.7 * t)) * hangCurve[a];
        const c2 = WAVE_SPEED * WAVE_SPEED;
        const dt2 = dt * dt;
        const decay = Math.exp(-Math.min(Math.max(CFG.damping, 0.05), 8) * dt);
        for (let y = 0; y < NODES; y++) {
            const up = Math.max(y - 1, 0) * NODES, down = Math.min(y + 1, SEG) * NODES, row = y * NODES;
            for (let x = 0; x < NODES; x++) {
                const i = row + x;
                const l = row + Math.max(x - 1, 0), r = row + Math.min(x + 1, SEG);
                const h = hCur[i];
                const lap = hCur[l] + hCur[r] + hCur[up + x] + hCur[down + x] - 4 * h;
                const acc = c2 * lap - STIFFNESS * h + windAmp * rowForce[x] * colForce[y];
                const next = 2 * h - hPrev[i] + dt2 * acc;
                let v = h + (next - h) * decay;
                if (v > 3.5) v = 3.5; else if (v < -3.5) v = -3.5;
                hNext[i] = v;
            }
        }
        for (let x = 0; x < NODES; x++) hNext[x] = 0; // preso pelo topo
        const spent = hPrev; hPrev = hCur; hCur = hNext; hNext = spent;
    }

    // Marca uma "impressão" gaussiana no campo (cursor/dedo, batida do carimbo)
    function imprint(px, py, radius, goal, rate) {
        const cellW = S.W / SEG, cellH = S.H / SEG;
        const rx = radius / cellW, ry = radius / cellH;
        const gx = px / cellW, gy = py / cellH;
        const x0 = Math.max(Math.ceil(gx - 2.5 * rx), 0), x1 = Math.min(Math.floor(gx + 2.5 * rx), SEG);
        const y0 = Math.max(Math.ceil(gy - 2.5 * ry), 1), y1 = Math.min(Math.floor(gy + 2.5 * ry), SEG);
        for (let y = y0; y <= y1; y++) {
            const oy = (y - gy) / ry;
            for (let x = x0; x <= x1; x++) {
                const ox = (x - gx) / rx;
                const g = Math.exp(-(ox * ox + oy * oy));
                if (g < 0.02) continue;
                const i = y * NODES + x;
                const pull = rate * g;
                hCur[i] += (goal * g - hCur[i]) * pull;
                hPrev[i] += (goal * g - hPrev[i]) * pull;
            }
        }
    }

    function foreshorten(axisStride, lineStride, ds, anchor, comp) {
        const ds2 = ds * ds;
        for (let l = 0; l < NODES; l++) {
            const base = l * lineStride;
            offsetData[(base + anchor * axisStride) * 2 + comp] = 0;
            let cum = 0;
            for (let k = anchor + 1; k < NODES; k++) {
                const i = base + k * axisStride;
                const dz = zField[i] - zField[i - axisStride];
                cum += ds - Math.sqrt(Math.max(ds2 - dz * dz, 0));
                offsetData[i * 2 + comp] = -cum;
            }
            cum = 0;
            for (let k = anchor - 1; k >= 0; k--) {
                const i = base + k * axisStride;
                const dz = zField[i] - zField[i + axisStride];
                cum += ds - Math.sqrt(Math.max(ds2 - dz * dz, 0));
                offsetData[i * 2 + comp] = cum;
            }
        }
    }

    function composeVertices() {
        const { W, H } = S;
        const cellW = W / SEG, cellH = H / SEG;
        const hidden = S.freeAll ? 0 : H - S.out; // parte ainda dentro da fenda
        const drape = CFG.drape * (0.3 + 0.7 * gust);
        for (let y = 0; y < NODES; y++) {
            const rowPx = (y / SEG) * H - hidden;           // distância abaixo da fenda/topo
            const t = Math.min(1, Math.max(0, rowPx / FIRM));
            const firm = t * t * (3 - 2 * t);                 // firme perto da fenda
            const hang = Math.pow(Math.min(1, Math.max(0, rowPx / H)), 1.3);
            const row = y * NODES;
            for (let x = 0; x < NODES; x++) {
                const i = row + x;
                zField[i] = (CFG.amplitude * Math.tanh(hCur[i]) * firm) + drape * hang;
            }
        }
        for (let y = 0; y < NODES; y++) {
            const up = Math.max(y - 1, 0) * NODES, down = Math.min(y + 1, SEG) * NODES, row = y * NODES;
            for (let x = 0; x < NODES; x++) {
                const i = row + x;
                const l = row + Math.max(x - 1, 0), r = row + Math.min(x + 1, SEG);
                const dzdx = (zField[r] - zField[l]) / (2 * cellW);
                const dzdy = (zField[down + x] - zField[up + x]) / (2 * cellH);
                const inv = 1 / Math.hypot(dzdx, dzdy, 1);
                const curve = zField[l] + zField[r] + zField[up + x] + zField[down + x] - 4 * zField[i];
                let fold = 1 - curve * 0.01;
                if (fold < 0.86) fold = 0.86; else if (fold > 1.06) fold = 1.06;
                const o = i * 4;
                vertexData[o] = zField[i];
                vertexData[o + 1] = -dzdx * inv;
                vertexData[o + 2] = -dzdy * inv;
                vertexData[o + 3] = fold;
            }
        }
        foreshorten(NODES, 1, cellH, 0, 1);
        foreshorten(1, NODES, cellW, SEG >> 1, 0);
    }

    function setupGL(snap) {
        const { W, H } = snap;
        const canvas = document.createElement("canvas");
        canvas.className = "fm-cloth-gl";
        canvas.setAttribute("aria-hidden", "true");
        const cw = W + BLEED * 2, ch = H + BLEED * 2;
        Object.assign(canvas.style, { width: `${cw}px`, height: `${ch}px`, left: `${-BLEED}px`, top: `${-BLEED}px` });
        canvas.width = Math.round(cw * S.dpr);
        canvas.height = Math.round(ch * S.dpr);
        const gl = canvas.getContext("webgl2", { alpha: true, depth: false, stencil: false, antialias: true, premultipliedAlpha: true });
        if (!gl) throw new Error("sem WebGL2");

        const cloth = link(gl, CLOTH_VERT, CLOTH_FRAG);
        const shadow = link(gl, SHADOW_VERT, SHADOW_FRAG);

        const grid = new Float32Array(NODES * NODES * 2);
        for (let y = 0; y < NODES; y++) {
            for (let x = 0; x < NODES; x++) {
                grid[(y * NODES + x) * 2] = x / SEG;
                grid[(y * NODES + x) * 2 + 1] = y / SEG;
            }
        }
        const idx = new Uint32Array(SEG * SEG * 6);
        let o = 0;
        for (let y = 0; y < SEG; y++) {
            for (let x = 0; x < SEG; x++) {
                const a = y * NODES + x, b = a + 1, c = a + NODES, d = c + 1;
                idx[o++] = a; idx[o++] = c; idx[o++] = b;
                idx[o++] = b; idx[o++] = c; idx[o++] = d;
            }
        }
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const gridBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
        gl.bufferData(gl.ARRAY_BUFFER, grid, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        const dataBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, dataBuf);
        gl.bufferData(gl.ARRAY_BUFFER, vertexData.byteLength, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
        const offBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, offBuf);
        gl.bufferData(gl.ARRAY_BUFFER, offsetData.byteLength, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
        const ib = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        gl.bindVertexArray(null);

        gl.activeTexture(gl.TEXTURE0);
        const contentTex = makeTexture(gl, snap.canvas);
        gl.activeTexture(gl.TEXTURE1);
        const stampSrc = snap.stamp ? snap.stamp.canvas : document.createElement("canvas");
        makeTexture(gl, stampSrc);

        canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); fail(); });
        Object.assign(S, { gl, canvas, W, H, cloth, shadow, vao, dataBuf, offBuf, contentTex, count: idx.length, cw, ch });
    }

    function render() {
        const gl = S.gl;
        const shift = S.freeAll ? 0 : -(S.H - S.out);
        gl.viewport(0, 0, S.canvas.width, S.canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindVertexArray(S.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, S.dataBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertexData);
        gl.bindBuffer(gl.ARRAY_BUFFER, S.offBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, offsetData);

        const radius = S.snap.radius;
        let u = S.shadow.uniforms;
        gl.useProgram(S.shadow.program);
        gl.uniform2f(u.uRes, S.W, S.H);
        gl.uniform2f(u.uOut, S.cw, S.ch);
        gl.uniform1f(u.uBleed, BLEED);
        gl.uniform1f(u.uShift, shift);
        gl.uniform1f(u.uShadow, CFG.shadow);
        gl.uniform1f(u.uRadius, radius);
        gl.drawElements(gl.TRIANGLES, S.count, gl.UNSIGNED_INT, 0);

        u = S.cloth.uniforms;
        gl.useProgram(S.cloth.program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, S.contentTex);
        gl.uniform1i(u.uContent, 0);
        gl.uniform1i(u.uStamp, 1);
        gl.uniform2f(u.uRes, S.W, S.H);
        gl.uniform2f(u.uOut, S.cw, S.ch);
        gl.uniform1f(u.uBleed, BLEED);
        gl.uniform1f(u.uShift, shift);
        gl.uniform1f(u.uFocal, CFG.perspective);
        gl.uniform1f(u.uLight, CFG.light);
        gl.uniform1f(u.uSheen, CFG.sheen);
        gl.uniform1f(u.uRadius, radius);
        gl.uniform3f(u.uInk, S.snap.ink[0], S.snap.ink[1], S.snap.ink[2]);
        const st = S.snap.stamp;
        let stampAlpha = 0, stampScale = 1;
        if (st && S.stampT >= 0) {
            const p = Math.min(1, Math.max(0, (S.stampT - 0.35) / 0.5));
            const c = 2.2; // cubic-bezier(.3,1.6,.5,1) aproximado: overshoot
            const e = 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
            stampScale = 2.2 - 1.2 * e;
            stampAlpha = 0.9 * Math.min(1, p * 1.6);
            gl.uniform2f(u.uStampC, st.cx, st.cy);
            gl.uniform1f(u.uStampSize, st.size);
        }
        gl.uniform1f(u.uStampScale, stampScale);
        gl.uniform1f(u.uStampAlpha, stampAlpha);
        gl.drawElements(gl.TRIANGLES, S.count, gl.UNSIGNED_INT, 0);
        gl.bindVertexArray(null);
    }

    function frame(now) {
        S.raf = 0;
        if (!S.running || !S.visible || document.hidden) return;
        const delta = Math.min((now - (S.last || now)) / 1000, 1 / 20);
        // vigia de desempenho: média do 20º ao 110º quadro
        if (S.last) {
            S.frames++;
            if (S.frames > 20) S.frameTime += now - S.last;
            if (S.frames === 110 && S.frameTime / 90 > 1000 / MIN_FPS) { fail(); return; }
        }
        S.last = now;

        const t = simTime;
        const target = Math.max(0.55 + 0.35 * Math.sin(t * 0.31 + 1.3) + 0.25 * Math.sin(t * 0.83) * (0.5 + 0.5 * Math.sin(t * 0.17)), 0.15);
        gust += (target - gust) * Math.min(delta * 2, 1);
        gustBoost *= Math.exp(-1.6 * delta);

        // cursor/dedo: segue com mola e "levanta" o tecido sob ele
        const sTarget = pointer.inside && S.freeAll ? 1 : 0;
        touch.s += (sTarget - touch.s) * Math.min(delta * (pointer.inside ? 8 : 2.5), 1);
        const omega = 14;
        touch.vx += ((pointer.x - touch.x) * omega * omega - 2 * omega * touch.vx) * delta;
        touch.vy += ((pointer.y - touch.y) * omega * omega - 2 * omega * touch.vy) * delta;
        touch.x += touch.vx * delta;
        touch.y += touch.vy * delta;
        if (touch.s > 0.01) imprint(touch.x, touch.y, CFG.brushSize, 1.1 * CFG.brush * touch.s, Math.min(delta * 4, 1));

        // carimbo: no impacto, afunda o papel naquele ponto e manda uma onda
        if (S.stampT >= 0) {
            S.stampT += delta;
            if (!S.pressed && S.stampT > 0.7 && S.snap.stamp) {
                S.pressed = true;
                imprint(S.snap.stamp.cx, S.snap.stamp.cy, 60, -1.6, 1);
                gustBoost += 0.6;
            }
        }

        S.debt = Math.min(S.debt + delta, DT * 5);
        while (S.debt >= DT) { stepSim(DT); S.debt -= DT; }
        composeVertices();
        render();
        S.raf = requestAnimationFrame(frame);
    }

    function start() {
        if (!S.running || S.raf || !S.visible) return;
        S.last = 0;
        S.raf = requestAnimationFrame(frame);
    }

    function fail() {
        S.running = false;
        if (S.raf) cancelAnimationFrame(S.raf);
        S.raf = 0;
        clearInterval(S.countTimer);
        S.canvas?.remove();
        S.onFail?.();
    }

    function interact() {
        const feed = S.feed;
        feed.style.touchAction = "pan-y"; // arrasto lateral mexe o papel; rolagem vertical segue normal
        feed.addEventListener("pointermove", (e) => {
            const r = feed.getBoundingClientRect();
            const x = e.clientX - r.left, y = e.clientY - r.top;
            if (touch.s < 0.01) { touch.x = x; touch.y = y; touch.vx = 0; touch.vy = 0; }
            pointer.x = x; pointer.y = y; pointer.inside = true;
        });
        const leave = () => { pointer.inside = false; };
        feed.addEventListener("pointerleave", leave);
        feed.addEventListener("pointerup", (e) => { if (e.pointerType !== "mouse") leave(); });
        feed.addEventListener("pointercancel", leave);
    }

    // ─── API ──────────────────────────────────────────────────────────────

    // "Fotografa" o ingresso antes de qualquer mudança na tela (chamado no "Processando")
    function prepare(ticket) {
        S.dpr = Math.min(2, window.devicePixelRatio || 1);
        S.prep = snapshot(ticket, S.dpr);
        S.prep.catch(() => {});
        return S.prep;
    }

    // Imprime: o papel desce pela fenda; só a parte de fora ondula. Resolve quando
    // termina de sair. Rejeita se não der (quem chama usa o ingresso estático).
    async function print({ feed, ticket, durationMs, onFail }) {
        S.feed = feed; S.ticket = ticket; S.onFail = onFail;
        const snap = await (S.prep || prepare(ticket));
        S.snap = snap;
        setupGL(snap);
        S.out = 0;
        S.running = true;
        composeVertices();
        render(); // primeiro quadro pronto antes de aparecer (sem piscada)
        feed.append(S.canvas);
        feed.classList.add("has-cloth");
        ticket.classList.add("is-cloth-source");

        // contador vivo: redesenha só a área dele e sobe esse pedaço da textura
        S.countTimer = setInterval(() => {
            const box = snap.repaintCount();
            if (!box || !S.gl) return;
            const gl = S.gl, d = S.dpr;
            const x = Math.floor(box.x * d), y = Math.floor(box.y * d);
            const w = Math.min(snap.canvas.width - x, Math.ceil(box.w * d));
            const h = Math.min(snap.canvas.height - y, Math.ceil(box.h * d));
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, S.contentTex);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, snap.ctx.getImageData(x, y, w, h));
        }, 1000);

        new IntersectionObserver(([entry]) => {
            S.visible = entry.isIntersecting;
            start();
        }).observe(S.canvas);
        document.addEventListener("visibilitychange", () => { if (!document.hidden) start(); });

        start();
        const t0 = performance.now();
        await new Promise((resolve) => {
            const feedFrame = (now) => {
                if (!S.running) { resolve(); return; }
                const t = Math.min(1, (now - t0) / durationMs);
                const eased = 1 - Math.pow(1 - t, 2.4);
                const stepJerk = Math.sin(t * Math.PI * 34) * 0.012 * (1 - t); // motor de passo
                S.out = Math.max(0, Math.min(1, eased + stepJerk)) * S.H;
                if (t < 1) { requestAnimationFrame(feedFrame); return; }
                S.out = S.H;
                S.freeAll = true; // cortado: fica pendurado pelo topo
                gustBoost += 0.5;
                interact();
                resolve();
            };
            requestAnimationFrame(feedFrame);
        });
        if (!S.running) throw new Error("tecido desativado");
    }

    function stamp() {
        if (!S.gl) return;
        S.stampT = 0;
        S.pressed = false;
    }

    function gustNow(n) { gustBoost += n; }

    window.TicketCloth = { supported, prepare, print, stamp, gust: gustNow };
})();
