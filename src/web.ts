/** The web UI's own pages: tokens, the bot's key, data, approving a login, and short messages. */
import { escapeHtml, page } from "./dashboard.ts";
import type { TokenInfo } from "./db.ts";

export function renderTokens(tokens: TokenInfo[], login: string): string {
  const rows = tokens.map((token) => `
      <li>
        <span class="excerpt"><strong>${
    escapeHtml(token.label)
  }</strong><br><span class="token-meta">approved by @${escapeHtml(token.approvedBy)} ${
    escapeHtml(token.createdAt)
  } · ${
    token.lastUsedAt === null ? "never used" : `last used ${escapeHtml(token.lastUsedAt)}`
  }</span></span>
        <form method="post" action="/tokens/${encodeURIComponent(token.id)}/revoke">
          <button>Revoke</button>
        </form>
      </li>`).join("");

  return page(
    "Tokens · dev-null-bridge",
    `  <h1>Tokens</h1>
  <p class="status">Each machine logged in with <code>devnull-bridge login</code>. Revoking one logs it out at once.</p>
  <section class="card">${
      rows === ""
        ? '\n    <p class="empty">No machines yet. Run <code>devnull-bridge login &lt;this server&gt;</code> on one.</p>'
        : `\n    <ul class="tokens">${rows}\n    </ul>`
    }
  </section>`,
    { login },
  );
}

export function renderBotKey(
  bot: string,
  publicKey: string | null,
  onGitHub: boolean | null,
  login: string,
): string {
  const keys = `https://github.com/${encodeURIComponent(bot)}.keys`;
  const check = onGitHub === true
    ? `<p class="status ok">Listed on <a href="${keys}">${escapeHtml(keys)}</a>.</p>`
    : onGitHub === false
    ? `<p class="status warn">Not on <a href="${keys}">${
      escapeHtml(keys)
    }</a> yet, so posting fails. Log in to GitHub as @${
      escapeHtml(bot)
    }, open <a href="https://github.com/settings/ssh/new">New SSH key</a>, choose <em>Authentication key</em>, and paste it.</p>`
    : `<p class="status">Could not ask GitHub whether <a href="${keys}">${
      escapeHtml(keys)
    }</a> has it.</p>`;
  return page(
    "Bot key · dev-null-bridge",
    `  <h1>Bot key</h1>
  <p class="status">The server signs @${
      escapeHtml(bot)
    }'s posts with a key it made itself; the private half never leaves it. dev-null.sh accepts a post when the public half is on the bot's GitHub.</p>
  <section class="card">${
      publicKey === null
        ? '\n    <p class="empty">No key yet: the server makes one when it starts.</p>'
        : `\n    <pre class="key">${escapeHtml(publicKey)}</pre>\n    ${check}`
    }
  </section>`,
    { login },
  );
}

export function renderData(login: string): string {
  return page(
    "Data · dev-null-bridge",
    `  <h1>Data</h1>
  <p class="status">Threads, subscriptions, messages and posts, as a sqlite file. Tokens are not in it.</p>
  <section class="card">
    <h2>Export</h2>
    <p><a href="/data/export">Download bridge.db</a></p>
  </section>
  <section class="card">
    <h2>Import</h2>
    <p class="meta">Replaces the threads, subscriptions, messages and posts here with those in the file:
    an export, or what <code>devnull-bridge-server export</code> wrote on a single-machine bridge.
    Tokens and the bot key stay.</p>
    <form method="post" action="/data/import" enctype="multipart/form-data">
      <p><input type="file" name="file" accept=".db,.sqlite,.sqlite3,application/vnd.sqlite3" required></p>
      <p><label><input type="checkbox" name="replace" value="yes" required> Replace what is here
      (<a href="/data/export">export it first</a> to keep a copy)</label></p>
      <button class="primary">Import</button>
    </form>
  </section>`,
    { login },
  );
}

export function renderImported(counts: Record<string, number>, login: string): string {
  const rows = Object.entries(counts).map(([table, n]) =>
    `<li><span class="excerpt">${escapeHtml(table)}</span><span>${n}</span></li>`
  ).join("");
  return page(
    "Imported · dev-null-bridge",
    `  <h1>Imported</h1>
  <p class="status">Rows read from the file. See them under <a href="/">Subscriptions</a>.</p>
  <section class="card">
    <ul class="tokens">${rows}</ul>
  </section>`,
    { login },
  );
}

export function renderApprove(
  code: string,
  pending: { label: string; createdAt: string },
  login: string,
): string {
  return page(
    "Approve login · dev-null-bridge",
    `  <h1>Let a machine in?</h1>
  <section class="card">
    <p><strong>${escapeHtml(pending.label)}</strong> asked to log in at ${
      escapeHtml(pending.createdAt)
    }. Check that its terminal shows this code:</p>
    <p class="code">${escapeHtml(code)}</p>
    <p class="meta">Its agents will be able to read the threads they watch and post as the bot.
    Only approve a login you started yourself just now: if someone else sent you this link, they get
    the token.</p>
    <form method="post" action="/approve">
      <input type="hidden" name="code" value="${escapeHtml(code)}">
      <button class="primary">Approve</button>
    </form>
  </section>`,
    { login },
  );
}

export function renderApproved(login: string): string {
  return page(
    "Approved · dev-null-bridge",
    `  <h1>Approved</h1>
  <p class="status">The terminal picks it up within a few seconds. See it under <a href="/tokens">Tokens</a>.</p>`,
    { login },
  );
}

export function renderMessage(
  title: string,
  text: string,
  action?: { href: string; text: string },
): string {
  return page(
    `${title} · dev-null-bridge`,
    `  <h1>${escapeHtml(title)}</h1>${
      text === "" ? "" : `\n  <p class="status">${escapeHtml(text)}</p>`
    }${
      action === undefined
        ? ""
        : `\n  <p><a href="${escapeHtml(action.href)}">${escapeHtml(action.text)}</a></p>`
    }`,
  );
}
