import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SmtpSession } from '../server/mail.js';

const socket = () => Object.assign(new EventEmitter(), { setEncoding() {}, write() {} });
const s = socket();
const session = new SmtpSession(s);
let completed = false;
const reply = session.reply().then(r => { completed = true; return r; });
s.emit('data', '250-hello\r\n250 START');
await Promise.resolve();
assert.equal(completed, false, 'a partial final line must not complete an SMTP reply');
s.emit('data', 'TLS\r\n');
assert.match((await reply).text, /STARTTLS/);
s.emit('data', '220 ready\r\n');
assert.equal((await session.reply()).code, 220, 'keep a greeting received before its waiter');
s.emit('close');
await assert.rejects(session.reply(), /closed/, 'future waiters reject after disconnect');
console.log('SMTP fragmented replies, queued greeting and disconnect: passed');
