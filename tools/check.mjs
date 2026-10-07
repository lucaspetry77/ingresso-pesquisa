import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontend = join(root, "frontend");
function files(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
const sourceManifest = JSON.parse(readFileSync(join(root, "docs/source-manifest.json")));
for (const entry of sourceManifest.unchangedFiles) {
    assert.equal(createHash("sha256").update(readFileSync(join(root, entry.file))).digest("hex"), entry.sha256, entry.file);
}
const assets = new Set(["/js/ticket-cloth.js"]);
for (const file of files(frontend)) {
    if (file.endsWith(".js")) {
        const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
        assert.equal(check.status, 0, check.stderr);
    }
    if (!/\.(html|css)$/.test(file)) continue;
    const content = readFileSync(file, "utf8");
    const references = file.endsWith(".html")
        ? [...content.matchAll(/(?:src|href)="([^"#]+)"/g)].map(match => match[1])
        : [...content.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(match => match[1]);
    for (const url of references) {
        if (/^(data:|https?:|#|%23)/.test(url) || url.startsWith("/f/")) continue;
        const plain = url.split(/[?#]/)[0];
        const target = url.startsWith("/") ? join(frontend, plain) : resolve(dirname(file), plain);
        assert.ok(existsSync(target), `Asset ausente: ${url} em ${file}`);
        assets.add(`/${target.slice(frontend.length + 1)}`);
    }
}
const fixtures = readdirSync(join(root, "examples/flows")).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(root, "examples/flows", name))));
assert.deepEqual(fixtures.map(flow => flow.flow_type).sort(), ["form", "form_print"]);
for (const flow of fixtures) {
    assert.equal(flow.blocks.length, 11, `${flow.slug}: preservar todos os blocos`);
    const ids = new Set(flow.blocks.map(block => block.id));
    assert.equal(ids.size, flow.blocks.length);
    for (const block of flow.blocks) {
        for (const rule of block.conditions || []) assert.ok(rule.target_block_id === "__finish__" || ids.has(rule.target_block_id), "Condição aponta para bloco ausente");
    }
}
console.log(`Integridade: ${sourceManifest.unchangedFiles.length} arquivos originais, ${assets.size} assets e 2 fluxos completos.`);

const stateDir = mkdtempSync(join(tmpdir(), "ingresso-pesquisa-check-"));
const server = spawn(process.execPath, [join(root, "tools/serve.mjs")], { env: { ...process.env, PORT: "0", DEMO_STATE_DIR: stateDir }, stdio: ["ignore", "pipe", "pipe"] });
let base;
try {
    base = await new Promise((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => reject(new Error("Servidor não iniciou")), 5000);
        server.stdout.on("data", data => {
            output += data;
            const match = output.match(/Prévia: (http:\/\/127\.0\.0\.1:\d+)/);
            if (match) { clearTimeout(timeout); resolve(match[1]); }
        });
        server.stderr.on("data", data => { clearTimeout(timeout); reject(new Error(String(data))); });
        server.once("error", error => { clearTimeout(timeout); reject(error); });
        server.once("exit", code => { clearTimeout(timeout); reject(new Error(`Servidor encerrou: ${code}`)); });
    });
    const post = async (path, payload) => {
        const response = await fetch(`${base}/api/public${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        assert.equal(response.status, 200, path);
        return response.json();
    };
    for (const asset of assets) assert.equal((await fetch(`${base}${asset}`)).status, 200, asset);
    for (const fixture of fixtures) {
        const page = await fetch(`${base}/f/${fixture.slug}`);
        assert.equal(page.status, 200);
        assert.ok((await page.text()).includes('id="fm-printer"'));
        const flow = await (await fetch(`${base}/api/public/f/${fixture.slug}`)).json();
        assert.deepEqual(flow.blocks, fixture.blocks.filter(b => b.is_active));
        const first = flow.blocks.find(b => b.variable_name);
        const prefill = { [first.variable_name]: "valor preenchido", origem: "verificação" };
        const { session_id } = await post("/sessions", { flow_id: flow.id, prefill, meta: { utm_source: "check" } });
        await post("/sessions/answer", { session_id, block_id: first.id, answer: "primeira resposta" });
        await post("/sessions/answer", { session_id, block_id: first.id, answer: "resposta substituída" });
        const completed = await post("/sessions/complete", { session_id });
        assert.equal(completed.whatsapp_link, flow.whatsapp_link);
        assert.deepEqual(await post("/sessions/complete", { session_id }), completed);
        const state = JSON.parse(readFileSync(join(stateDir, "sessions.json")))[session_id];
        assert.equal(state.responses[first.id].answer, "resposta substituída");
        assert.equal(state.prefill.origem, "verificação");
        assert.equal(state.meta.utm_source, "check");
        assert.equal(state.is_completed, true);
        if (flow.whatsapp_link) {
            const redirect = await fetch(`${base}/api/public/sessions/${session_id}/redirect`, { redirect: "manual" });
            assert.equal(redirect.status, 302);
            assert.equal(redirect.headers.get("location"), flow.whatsapp_link);
            assert.equal(JSON.parse(readFileSync(join(stateDir, "sessions.json")))[session_id].clicked_link, true);
        }
    }
    assert.equal((await fetch(`${base}/api/public/f/inexistente`)).status, 404);
    assert.equal((await fetch(`${base}/f/inexistente`)).status, 404);
    console.log("Prévia: rotas, assets, pré-preenchimento, substituição de resposta, conclusão e redirecionamento verificados nos dois fluxos.");
} finally {
    const stopped = once(server, "exit");
    if (server.exitCode === null) { server.kill(); await stopped; }
    rmSync(stateDir, { recursive: true, force: true });
}
