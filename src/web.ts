/** The web UI's own pages: tokens, approving a login, and short messages. */
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
