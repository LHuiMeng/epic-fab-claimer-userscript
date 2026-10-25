import io

p = 'epic-fab-claimer.user.js'
s = io.open(p, encoding='utf-8').read()


def rep(o, n):
    global s
    assert o in s, 'MISS ' + o[:60]
    s = s.replace(o, n, 1)


rep("// @version      1.5.0", "// @version      1.5.1")
rep("  const VERSION = '1.5.0';", "  const VERSION = '1.5.1';")

raw_old = "https://raw.githubusercontent.com/LHuiMeng/epic-fab-claimer-userscript/main/epic-fab-claimer.user.js"
cdn_new = "https://fastly.jsdelivr.net/gh/LHuiMeng/epic-fab-claimer-userscript@main/epic-fab-claimer.user.js"
assert s.count(raw_old) == 2, s.count(raw_old)
s = s.replace(raw_old, cdn_new)

rep("    root.querySelector('b').textContent = title;",
    "    root.querySelector('b').textContent = `${title} \u00b7 v${VERSION}`;")

rep("  async function boot() {\n    const host = location.hostname;",
    "  async function boot() {\n    const host = location.hostname;\n"
    "    await log(`Epic/Fab \u52a9\u624b v${VERSION} \u5df2\u52a0\u8f7d\uff08${host}\uff09`);")

rep("        window.GM_registerMenuCommand('\u2699 \u811a\u672c\u8bbe\u7f6e', () => { openSettings(); });",
    "        window.GM_registerMenuCommand('\u2699 \u811a\u672c\u8bbe\u7f6e', () => { openSettings(); });\n"
    "        window.GM_registerMenuCommand('\U0001f501 \u68c0\u67e5\u66f4\u65b0 / \u91cd\u88c5', () => {\n"
    "          gmOpenTab(`${CDN_URL}?t=${Date.now()}`, { active: true });\n"
    "        });")

rep("  const STORE = 'https://store.epicgames.com';",
    "  const CDN_URL = 'https://fastly.jsdelivr.net/gh/LHuiMeng/epic-fab-claimer-userscript@main/epic-fab-claimer.user.js';\n"
    "  const STORE = 'https://store.epicgames.com';")

io.open(p, 'w', encoding='utf-8').write(s)
print('ok v1.5.1')
