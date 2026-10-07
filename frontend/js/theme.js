// Variantes de cor do Asimov Design System (ds/themes.js) aplicadas como
// tokens --ui-* no chat público, via ?tema=<chave> na URL.
// O painel usa sempre o Teal padrão definido em css/styles.css.
(() => {
    const DEFAULT_THEME = "teal_asimov";

    function applyTheme(key) {
        const theme = window.AsimovThemes?.[key];
        if (!theme) return false;
        const root = document.documentElement;
        Object.entries(theme).forEach(([token, value]) => root.style.setProperty(`--ui-${token}`, value));
        const hex = theme.accent.slice(1);
        const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");
        root.style.setProperty("--ui-accent-rgb-space", rgb);
        root.dataset.theme = key;
        // A aurora lê --ui-accent para calcular o hue-rotate do shader
        window.AsimovAurora?.instances.forEach((instance) => instance.refresh());
        return true;
    }

    const requested = new URLSearchParams(location.search).get("tema");
    if (requested && requested !== DEFAULT_THEME) applyTheme(requested);
})();
