import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Per-runtime capability, outside every task's command sandbox. Same-user host
// processes are trusted; origin checks and a capability protect browser clients.
export function createSession(enabled = true) {
  const token = randomBytes(32).toString('hex');
  let tokenPath;
  const matches = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  return {
    enabled,
    accepts(req) {
      if (!enabled) return true;
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('g0d_session='))?.slice(12);
      return matches(bearer) || matches(cookie);
    },
    exchange(value, res) {
      if (!enabled || matches(value)) {
        res.setHeader('Set-Cookie', `g0d_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
        return true;
      }
      return false;
    },
    accessUrl(base) { return enabled ? `${base}/#session=${token}` : base; },
    async publishToken(port) {
      if (!enabled) return;
      const directory = path.join(os.tmpdir(), `g0dc0d3-sessions-${process.getuid?.() ?? 'user'}`);
      await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error('Unsafe local session directory');
      tokenPath = path.join(directory, `${port}.json`);
      const temporary = `${tokenPath}.${randomBytes(12).toString('hex')}`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ port, pid: process.pid, token }), { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, tokenPath);
      } finally { await fs.unlink(temporary).catch(() => {}); }
    },
    async close() {
      if (!tokenPath) return;
      try { const value = JSON.parse(await fs.readFile(tokenPath, 'utf8')); if (matches(value.token)) await fs.unlink(tokenPath); } catch {}
    },
  };
}
