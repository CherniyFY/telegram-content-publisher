# Telegram content publisher

An MIT-licensed, self-hosted publisher for selected content and invited Telegram
recipients. It does not read ChatGPT conversations or translate text. A publisher
or an authorized MCP client supplies the content copies to send.

Features: individual invitations, private-chat verification, ru/en/pt preferences,
stop/resume commands, per-recipient delivery receipts, duplicate protection, and
an authenticated stateless MCP endpoint. A continuous poller registers recipients
while the server runs. A failed recipient does not block other recipients.

## Run locally

Use Node 24 (minimum Node 22.18). No npm dependencies or build step are needed.

1. Copy `.env.example` to `.env`.
2. Generate two independent secrets with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
   Put one in `ADMIN_API_TOKEN` and the other in `TOKEN_ENCRYPTION_KEY`.
3. Run `npm start`. Keep this process running for invitations and stop commands.
4. Create a dedicated bot with Telegram's official @BotFather and `/newbot`.
5. Run `node --env-file=.env scripts/admin.ts save` and enter one JSON object on
   stdin: `{"token":"YOUR_BOTFATHER_TOKEN"}`. End stdin with Ctrl+D. Do not put
   real tokens in command arguments, committed files, screenshots, or chat.
6. Open the returned `pairingUrl`, press Start in Telegram, then run
   `node --env-file=.env scripts/admin.ts pair`.

The owner chat anchors the publisher account. Creating invitations requires this
verification, but publishing to subscribers does not have to include the owner.
Do not attach a bot used by another webhook service. SQLite state lives in the
ignored `data/` folder; back it up together with the encryption key. Losing the
key makes saved bot tokens unreadable.

## Invite and verify

```sh
node --env-file=.env scripts/admin.ts invite "Guest A" ru
node --env-file=.env scripts/admin.ts status
node --env-file=.env scripts/admin.ts test RECIPIENT_ID
```

Send the returned invitation link privately to its intended person. It is single
use, expires after seven days and is shown only at creation. The recipient opens
it and presses Start. The running poller verifies the real private chat, saves
an active subscription, and sends a registration acknowledgement. `status`
returns the recipient's stored ID and name. `test` confirms Telegram acceptance
for that destination; it cannot prove that the person read the message.

Recipients can send `/stop`, `/start`, or `/language ru`, `/language en`, and
`/language pt`. The owner can use `pause ID`, `resume ID`, `remove ID`, or
`revoke INVITE_ID` in the same admin script. A removed recipient needs a fresh
invitation. Plain Start never registers a stranger. Labels are reminders, not
identity checks: whoever redeems a personal invitation first owns its destination.

## Publish selected content

Edit `examples/selected-content.json`, keeping a stable key for each content item.
Supply the copies you want to send, already translated into the recipients'
preferred languages. Missing languages are reported as skipped; no automatic
translation or fallback occurs.

```sh
node --env-file=.env scripts/admin.ts publish examples/selected-content.json
```

The JSON shape is:

```json
{
  "content_key": "example_001",
  "copies": {"ru": "Русская копия", "en": "English copy", "pt": "Cópia em português"},
  "include_owner": false
}
```

Only active invited subscribers receive the matching copy. `include_owner: true`
adds the verified owner's chat using the Russian copy, when supplied. Results
list individual successful, skipped, failed or uncertain deliveries. Repeating
a completed key/text returns its receipt. A key cannot be overwritten with
different text. Failed or uncertain attempts are never retried silently.

## HTTP and MCP

Admin routes require `Authorization: Bearer <ADMIN_API_TOKEN>`. The listener
binds to loopback by default. There is no public unauthenticated admin API.

- `/api/telegram/status` (GET): owner and recipient status.
- `/api/telegram/save`, `/pair`, `/invite`, `/sync`, `/subscriber-test`,
  `/subscription`, `/revoke-invite` (POST under `/api/telegram/`).
- `/api/publish` (POST): the content JSON above.
- `/mcp` (POST): stateless JSON-RPC initialization, discovery, and calls.

MCP tools: `telegram_connection_status`, `telegram_create_invite`,
`telegram_sync_subscribers`, `telegram_test_subscriber`, and
`publish_telegram_content`. The last tool accepts `content_key`, `copies`, and
optional `include_owner`. Connect using an MCP client that supports bearer auth.
For a ChatGPT-hosted plugin, deploy through its supported hosting/authentication
integration; this repository does not bundle an OAuth authorization server.

For a remote deployment, put the loopback service behind an HTTPS reverse proxy
and set `PUBLIC_ORIGIN` and the CLI's `ADMIN_URL` to its external origin, without
a trailing slash. Validate the integration before enabling unattended publishing.
Do not make admin access anonymous. Persist `data/`; supervise the Node process.
This server polls Telegram rather than using a webhook. If it is stopped,
registrations and opt-out commands wait; Telegram retains updates for at most
24 hours. The server must stay running for reliable recipient preferences.

## Tests and privacy

`npm test` runs SQLite-backed registration and fan-out tests, durable migration
checks, and an actual local HTTP authentication test. Telegram replies are
simulated in automated tests; live verification requires real opt-in and receipts.
Tests use synthetic credentials and destinations. Releases contain no production
bot token, chat IDs, subscriber records, encryption key, or site identity.

No scheduling is enabled by default. Existing content-producing schedules should
call the publisher after preparing approved content, using stable keys and
checking individual results. Delivery records indicate Telegram API acceptance,
not reading, listening, language proficiency, or activity points.
