// The page of the web app as the page of the shell (scripts/prepare.mjs writes it as www/index.html).

/** The policy of the web server (web/scripts/serve.mjs) for a <meta>: `frame-ancestors` is the one directive that a <meta> can't carry. */
export function metaPolicy(policy) {
  return policy
    .split("; ")
    .filter((directive) => !directive.startsWith("frame-ancestors"))
    .join("; ");
}

/**
 * What a web server says in a header about what the page may load and do, the page says in itself (a WebView has no server in front of
 * it), right after the charset; and the shell's script goes before the app's, so that what it gives (`window.__zimShell`) is there when the
 * app starts.
 */
export function shellPage(html, policy) {
  const charset = '<meta charset="utf-8" />';
  if (!html.includes(charset)) throw new Error("There is no charset in index.html: the policy goes after it.");
  const guarded = html.replace(charset, `${charset}\n    <meta http-equiv="Content-Security-Policy" content="${metaPolicy(policy)}" />`);
  const at = guarded.search(/<script\b[^>]*type="module"/);
  if (at < 0) throw new Error("The app's script was not found in index.html.");
  return `${guarded.slice(0, at)}<script type="module" src="./shell.js"></script>\n    ${guarded.slice(at)}`;
}
