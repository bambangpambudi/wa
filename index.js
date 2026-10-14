import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import {
  makeWASocket,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { config } from './src/lib/config.js';
import { loadCommands, executeCommand } from './src/lib/handler.js';
import { initDatabase, getGroup, saveDatabase, recordGroupEvent } from './src/lib/database.js';
import { jidNumber, sleep } from './src/lib/utils.js';
import { createSendLimiter, getRiskLevel, recordRisk, randomHumanDelay } from './src/lib/anti-spam.js';
import { renderGroupTemplate } from './src/lib/group-features.js';
import { makeWelcomeCard } from './src/lib/welcome-card.js';

const OWNER_NUMBER = config.ownerNumbers[0] || '';

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function normalizeNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

global.ownerNumber = OWNER_NUMBER;
let reconnectTimer = null;
let starting = false;
let pairingMode = false;
let pairingNumber = '';

// Prevent duplicate processing when the same WhatsApp message is delivered
// more than once by the event layer or during reconnect/history sync.
const processedMessageIds = new Map();

function messageKey(message) {
  const remote = message?.key?.remoteJid || '';
  const id = message?.key?.id || '';
  const participant = message?.key?.participant || '';
  return `${remote}:${participant}:${id}`;
}

function shouldProcessMessage(message) {
  const key = messageKey(message);
  if (!key.endsWith(':')) {
    const now = Date.now();
    // Keep the dedupe cache small and temporary.
    for (const [cached, expires] of processedMessageIds) {
      if (expires <= now) processedMessageIds.delete(cached);
    }
    if (processedMessageIds.has(key)) return false;
    processedMessageIds.set(key, now + 2 * 60 * 1000);
  }
  return true;
}


async function startBot() {
  if (starting) return;
  starting = true;

  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir);

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    browser: Browsers.ubuntu('Chrome'),
    logger: pino({ level: 'silent' }),
    generateHighQualityLinkPreview: true,
    keepAliveIntervalMs: 30_000,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    markOnlineOnConnect: true,
    syncFullHistory: false,
  });

  // Outgoing pacing: queue messages per chat to reduce accidental bursts.
  // This improves stability but cannot guarantee protection from WhatsApp enforcement.
  const originalSendMessage = sock.sendMessage.bind(sock);
  const limiter = createSendLimiter(config.sendLimiter || {});
  sock.sendMessage = async (jid, content, options) => {
    const send = () => originalSendMessage(jid, content, options);
    if (!config.sendLimiter?.enabled) return send();
    try {
      return await limiter(jid, send);
    } catch (error) {
      const risk = getRiskLevel(error?.output?.statusCode || error?.statusCode, error?.message);
      if (risk && recordRisk('send-error', risk)) {
        const ownerJid = OWNER_NUMBER ? `${OWNER_NUMBER}@s.whatsapp.net` : null;
        if (ownerJid) {
          try {
            await originalSendMessage(ownerJid, {
              text: `⚠️ *WhatsApp Risk Alert*\n\nLevel: ${risk}\nChat: ${jid}\nError: ${error?.message || 'send failed'}\n\nThe bot is reducing send speed to maintain stability.`
            });
          } catch {}
        }
      }
      throw error;
    }
  };

  sock.ev.on('creds.update', saveCreds);

  let pairingRequested = false;
  let pairingTimer = null;

  const requestPairingCode = async () => {
    if (pairingRequested || state.creds.registered || !pairingMode || !pairingNumber) return;
    pairingRequested = true;

    console.log(chalk.gray(`\n [ PAIRING ] Requesting pairing code for ${pairingNumber}...`));
    try {
      const code = await sock.requestPairingCode(pairingNumber);
      const formatted = String(code).replace(/\s/g, '').match(/.{1,4}/g)?.join('-') || code;
      console.log(chalk.whiteBright('\n ╭──────────────────────────────╮'));
      console.log(chalk.whiteBright(' │ ') + chalk.yellowBright('KODE PAIRING ANDA: ') + chalk.bold.cyanBright(formatted) + chalk.whiteBright(' │'));
      console.log(chalk.whiteBright(' ╰──────────────────────────────╯'));
      console.log(chalk.gray('\n WhatsApp > Linked devices > Link a device > Link with phone number\n'));
    } catch (error) {
      pairingRequested = false;
      console.error(chalk.redBright(' [ PAIRING ERROR ] '), error?.message || error);
      console.log(chalk.yellow(' [ PAIRING ] Request failed. The socket will retry when ready.'));
      clearTimeout(pairingTimer);
      pairingTimer = setTimeout(requestPairingCode, 3000);
    }
  };

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !state.creds.registered && !pairingMode) {
      console.log(chalk.whiteBright('\n [ SCAN QR CODE ]'));
      qrcode.generate(qr, { small: true });
    }

    // Match the Paimon-style flow: wait for the socket to enter connecting,
    // then request the pairing code after a short delay.
    if (pairingMode && !state.creds.registered && connection === 'connecting') {
      clearTimeout(pairingTimer);
      pairingTimer = setTimeout(requestPairingCode, 2000);
    }

    if (connection === 'open') {
      starting = false;
      const connectedAs = sock.user?.id?.split(':')[0] || sock.user?.id || 'unknown';
      console.log(chalk.greenBright('\n [ CONNECTED ] ') + chalk.whiteBright(`Connected as: ${connectedAs}`));
      console.log(chalk.gray(` [ OWNER ] ${OWNER_NUMBER}`));
      console.log(chalk.gray(` [ PREFIX ] ${config.prefix}\n`));
    }

    if (connection === 'close') {
      starting = false;
      clearTimeout(pairingTimer);
      const statusCode = lastDisconnect?.error
        ? new Boom(lastDisconnect.error).output.statusCode
        : undefined;

      console.log(chalk.gray(`\n [ DISCONNECT ] Status code: ${statusCode ?? 'unknown'}`));

      const risk = getRiskLevel(statusCode, lastDisconnect?.error?.message);
      if (risk && recordRisk('disconnect', `${risk}:${statusCode}`)) {
        const ownerJid = OWNER_NUMBER ? `${OWNER_NUMBER}@s.whatsapp.net` : null;
        if (ownerJid) {
          try {
            await sock.sendMessage(ownerJid, {
              text: `🚨 *WhatsApp Risk Alert*\n\nLevel: ${risk}\nStatus: ${statusCode ?? 'unknown'}\nReason: ${lastDisconnect?.error?.message || 'unknown'}\n\nReview sending activity and reduce bursts. This is not a definitive indication that the account will be blocked.`
            });
          } catch {}
        }
      }

      if (statusCode === DisconnectReason.restartRequired) {
        console.log(chalk.yellow(' [ RECONNECT ] Status 515 (restart required), reconnecting with the saved session...'));
      } else if (statusCode === DisconnectReason.connectionReplaced) {
        console.log(chalk.yellow(' [ RECONNECT ] Connection was replaced by another device, reconnecting...'));
      } else if (statusCode === DisconnectReason.loggedOut) {
        console.log(chalk.red(' [ LOGGED OUT ] Session logged out. Remove the session folder and pair again.'));
        return;
      } else if (statusCode === DisconnectReason.badSession || statusCode === DisconnectReason.multideviceMismatch) {
        console.log(chalk.red(' [ SESSION ERROR ] Session is invalid. Remove the session folder and pair again.'));
        return;
      } else {
        console.log(chalk.yellow(' [ RECONNECT ] Connection closed, reconnecting...'));
      }

      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          startBot().catch((error) => {
            starting = false;
            console.error(chalk.red('[ START ERROR ]'), error?.message || error);
          });
        }, statusCode === DisconnectReason.connectionReplaced ? 5000 : 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const message of messages) {
      try {
        if (!shouldProcessMessage(message)) continue;
        const jid = message.key.remoteJid;
        if (config.humanEntropy?.enabled && jid) {
          await sleep(randomHumanDelay(config.humanEntropy.minDelayMs, config.humanEntropy.maxDelayMs));
        }
        if (config.readMessages && jid) {
          await sock.readMessages([message.key]);
        }
        if (config.autoTyping && jid && !jid.endsWith('@status')) {
          try { await sock.sendPresenceUpdate('composing', jid); } catch {}
        }
        await executeCommand(sock, message);
        if (config.autoTyping && jid && !jid.endsWith('@status')) {
          try { await sock.sendPresenceUpdate('paused', jid); } catch {}
        }
      } catch (error) {
        console.error(chalk.red('[ COMMAND ERROR ]'), error?.message || error);
      }
    }
  });

  sock.ev.on('call', async (calls) => {
    if (!config.antiCall) return;
    for (const call of calls || []) {
      if (call.status !== 'offer') continue;
      try {
        await sock.rejectCall(call.id, call.from);
        console.log(chalk.yellow(` [ ANTICALL ] Call rejected from ${call.from}`));
      } catch (error) {
        console.error(chalk.red('[ ANTICALL ERROR ]'), error?.message || error);
      }
    }
  });

  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    try {
      const settings = getGroup(id);
      const metadata = await sock.groupMetadata(id).catch(() => null);
      const count = metadata?.participants?.length || 0;
      const groupName = metadata?.subject || 'Group';

      if (action === 'add') recordGroupEvent(id, 'joins', participants.length);
      if (action === 'remove') recordGroupEvent(id, 'leaves', participants.length);
      await saveDatabase();

      const enabled = (action === 'add' && settings.welcome) || (action === 'remove' && settings.goodbye);
      if (!enabled) return;

      for (const participant of participants) {
        const user = typeof participant === 'string' ? participant : participant?.id;
        if (!user) continue;
        const mention = `@${jidNumber(user)}`;
        const template = action === 'add' ? settings.welcomeText : settings.goodbyeText;
        const text = renderGroupTemplate(template, {
          name: jidNumber(user),
          mention,
          group: groupName,
          count,
        }).replaceAll('{prefix}', config.prefix);

        // Send plain text when no custom banner is configured.
        // Use the custom banner only when one has been explicitly set.
        try {
          const bannerPath = action === 'add' ? settings.welcomeImage : settings.goodbyeImage;
          let banner = null;
          if (bannerPath) {
            try { banner = fs.readFileSync(path.resolve(config.root, bannerPath)); } catch {}
          }

          if (!banner) {
            await sock.sendMessage(id, { text, mentions: [user] });
            continue;
          }

          const card = await makeWelcomeCard({
            banner,
            name: jidNumber(user),
            group: groupName,
            count,
            type: action === 'add' ? 'welcome' : 'goodbye'
          });
          await sock.sendMessage(id, { image: card, caption: text, mentions: [user] });
        } catch (error) {
          await sock.sendMessage(id, { text, mentions: [user] });
        }
      }
    } catch (error) {
      console.error(chalk.red('[ GROUP EVENT ERROR ]'), error?.message || error);
    }
  });

  return sock;
}

await initDatabase();
await loadCommands();

console.clear();
console.log(chalk.cyan(`
╭──────────────────────────────────────────╮
│           WHATSAPP STORE BOT             │
│          PAIMON-STYLE CONNECT            │
╰──────────────────────────────────────────╯
`));
console.log(chalk.gray(` [ OWNER ] ${OWNER_NUMBER}`));

const savedSession = await useMultiFileAuthState(config.sessionDir);
const isRegistered = savedSession.state.creds.registered;

if (isRegistered) {
  pairingMode = false;
  console.log(chalk.green(' [ SESSION ] Session found, connecting directly...\n'));
} else {
  const mode = await ask(chalk.cyan(' Use pairing mode (code)? ') + chalk.green('[yes/no]: '));
  pairingMode = mode.toLowerCase() === 'yes';

  if (pairingMode) {
    pairingNumber = normalizeNumber(await ask(
      chalk.cyan(' Enter WhatsApp number ') + chalk.gray('(example: 628xxx)') + chalk.cyan(': '),
    ));

    if (!/^\d{8,15}$/.test(pairingNumber)) {
      throw new Error('Invalid WhatsApp number. Example: 628123456789');
    }
  }
}

await startBot();

process.on('SIGINT', async () => {
  await saveDatabase();
  process.exit(0);
});
