/* ============================================================================
 * first-commit — outbound email
 * ----------------------------------------------------------------------------
 * Two transports, one interface, no dependencies.
 *
 *   FileTransport  the default. Writes each message to data/outbox/ and prints
 *                  the link. Nothing is sent anywhere. This is not a stub — it
 *                  is the right transport for a course running on a laptop or
 *                  on a box with no mail relay, and it means verification and
 *                  password reset work on the day you start rather than after
 *                  you have configured SMTP.
 *
 *   SmtpTransport  real submission over TLS, configured by one URL. Enough
 *                  SMTP to hand a message to a relay and no more: EHLO,
 *                  STARTTLS, AUTH PLAIN/LOGIN, MAIL/RCPT/DATA.
 *
 * Mail is never load-bearing for the course itself. If sending fails, the
 * caller logs it and carries on — a learner is not blocked from studying
 * because a relay was down.
 * ========================================================================== */

import fs from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';

/** Header injection: a newline in a header turns one message into two. */
const headerSafe = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();

function buildMessage({ from, to, subject, text }) {
  const headers = [
    `From: ${headerSafe(from)}`,
    `To: ${headerSafe(to)}`,
    `Subject: ${headerSafe(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    `Date: ${new Date().toUTCString()}`,
  ];
  // A lone "." on a line ends DATA, so any real one has to be doubled.
  const body = String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  return headers.join('\r\n') + '\r\n\r\n' + body + '\r\n';
}

/* ------------------------------ file transport ---------------------------- */

export class FileTransport {
  /** @param {string} dir where messages are written */
  constructor(dir, { log = console.log } = {}) {
    this.dir = dir;
    this.log = log;
    this.name = 'file';
  }

  async send(message) {
    await fs.mkdir(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeTo = headerSafe(message.to).replace(/[^A-Za-z0-9@._-]/g, '_');
    const file = path.join(this.dir, `${stamp}-${safeTo}.txt`);
    await fs.writeFile(file, buildMessage(message), 'utf8');
    // The link is the whole point of the message; print it so a self-hoster
    // never has to go and open the file.
    const link = (message.text.match(/https?:\/\/\S+/) || [])[0];
    this.log(`[mail] ${message.subject} → ${message.to}`);
    this.log(`[mail] written to ${file}`);
    if (link) this.log(`[mail] link: ${link}`);
    return { transport: 'file', file };
  }
}

/* ------------------------------ smtp transport ---------------------------- */

/**
 * One SMTP conversation. Deliberately small and deliberately strict.
 *
 * A reply may span several lines: continuations are `250-text` and the last
 * line is `250 text`, with a space. So a reply is complete at the first line
 * whose fourth character is a space — anything before that is still arriving.
 */
export class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.pending = [];
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.onData(String(chunk)));
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => this.fail(new Error('SMTP connection closed')));
  }

  fail(err) {
    while (this.pending.length) this.pending.shift().reject(err);
  }

  onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const lines = this.buffer.split(/\r?\n/);
      const end = lines.findIndex((line) => /^\d{3} /.test(line));
      if (end === -1) return;                       // still mid-reply
      const reply = lines.slice(0, end + 1);
      this.buffer = lines.slice(end + 1).join('\r\n');
      const waiter = this.pending.shift();
      if (waiter) waiter.resolve({ code: Number(reply[end].slice(0, 3)), text: reply.join('\n') });
      else return;                                  // unsolicited; ignore
    }
  }

  reply() {
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  async command(line, expected) {
    if (line !== null) this.socket.write(line + '\r\n');
    const res = await this.reply();
    if (expected && !expected.includes(res.code)) {
      throw new Error(`SMTP ${res.code}: ${res.text.split('\n').pop()}`);
    }
    return res;
  }
}

export class SmtpTransport {
  /**
   * @param {string} url  smtps://user:pass@host:465  (implicit TLS)
   *                      smtp://user:pass@host:587   (STARTTLS, required)
   */
  constructor(url, { timeoutMs = 15000 } = {}) {
    const parsed = new URL(url);
    this.implicitTls = parsed.protocol === 'smtps:';
    this.host = parsed.hostname;
    this.port = Number(parsed.port) || (this.implicitTls ? 465 : 587);
    this.user = parsed.username ? decodeURIComponent(parsed.username) : null;
    this.pass = parsed.password ? decodeURIComponent(parsed.password) : null;
    this.timeoutMs = timeoutMs;
    this.name = 'smtp';
  }

  connect() {
    return new Promise((resolve, reject) => {
      const opts = { host: this.host, port: this.port, servername: this.host };
      const socket = this.implicitTls
        ? tls.connect(opts, () => resolve(socket))
        : net.connect(opts, () => resolve(socket));
      socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error('SMTP timed out')));
      socket.once('error', reject);
    });
  }

  async send(message) {
    let socket = await this.connect();
    let session = new SmtpSession(socket);
    try {
      await session.command(null, [220]);
      const greeting = await session.command('EHLO first-commit', [250]);

      if (!this.implicitTls) {
        // Credentials must never cross a plaintext link, so STARTTLS is not
        // optional: if the relay cannot do it, we do not send.
        if (!/STARTTLS/i.test(greeting.text)) throw new Error('SMTP relay does not offer STARTTLS');
        await session.command('STARTTLS', [220]);
        socket = tls.connect({ socket, servername: this.host });
        await new Promise((res, rej) => {
          socket.once('secureConnect', res);
          socket.once('error', rej);
        });
        session = new SmtpSession(socket);
        await session.command('EHLO first-commit', [250]);
      }

      if (this.user) {
        const plain = Buffer.from(`\0${this.user}\0${this.pass}`, 'utf8').toString('base64');
        try {
          await session.command(`AUTH PLAIN ${plain}`, [235]);
        } catch {
          await session.command('AUTH LOGIN', [334]);
          await session.command(Buffer.from(this.user, 'utf8').toString('base64'), [334]);
          await session.command(Buffer.from(this.pass, 'utf8').toString('base64'), [235]);
        }
      }

      await session.command(`MAIL FROM:<${headerSafe(message.from)}>`, [250]);
      await session.command(`RCPT TO:<${headerSafe(message.to)}>`, [250, 251]);
      await session.command('DATA', [354]);
      socket.write(buildMessage(message) + '.\r\n');
      await session.command(null, [250]);
      await session.command('QUIT').catch(() => {});
      return { transport: 'smtp', host: this.host };
    } finally {
      socket.destroy();
    }
  }
}

/**
 * @param {{ smtpUrl?: string, outbox: string, from: string }} config
 */
export function createTransport({ smtpUrl, outbox }) {
  return smtpUrl ? new SmtpTransport(smtpUrl) : new FileTransport(outbox);
}

/* -------------------------------- messages -------------------------------- */

export const messages = {
  verify: ({ brand, name, link }) => ({
    subject: `Confirm your email for ${brand}`,
    text: `Hello ${name},

Confirm this address to finish setting up your ${brand} account:

${link}

The link works once, and expires in 24 hours. If you did not sign up, you can
ignore this — no account will be usable with your address.`,
  }),

  reset: ({ brand, name, link }) => ({
    subject: `Reset your ${brand} password`,
    text: `Hello ${name},

Someone asked to reset the password for your ${brand} account. Choose a new one
here:

${link}

The link works once, and expires in one hour. Signing in with your old password
still works until you use it.

If this was not you, you do not need to do anything: the link is the only way to
change the password, and nobody else has it.`,
  }),
};
