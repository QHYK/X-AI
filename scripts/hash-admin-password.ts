import { createAdminPasswordHash } from '../src/lib/admin-auth.js';

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').trimEnd();
  }
  process.stdout.write('Admin password: ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let password = '';
    const onData = (chunk: Buffer) => {
      const value = chunk.toString('utf8');
      if (value === '\u0003') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\n');
        reject(new Error('Cancelled.'));
      } else if (value === '\r' || value === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\n');
        resolve(password);
      } else if (value === '\u007f') {
        password = password.slice(0, -1);
      } else {
        password += value;
      }
    };
    process.stdin.on('data', onData);
  });
}

const password = await readPassword();
if (password.length < 8) throw new Error('Admin password must contain at least 8 characters.');
console.log(await createAdminPasswordHash(password));
