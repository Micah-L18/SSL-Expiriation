'use strict';

// Turns a password into the AUTH_PASSWORD_HASH line for .env.
//   node scripts/hash-password.js            asks for it twice, without showing it
//   echo 'the password' | node scripts/hash-password.js

const { hashPassword } = require('../lib/auth');

const MIN_LENGTH = 12;

// One line from the terminal with nothing echoed back.
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    let typed = '';
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    function finish(result) {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stderr.write('\n');
      result === null ? reject(new Error('Cancelled')) : resolve(result);
    }
    function onData(chunk) {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish(typed);
        if (char === '\u0003' || char === '\u0004') return finish(null);
        if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1);
        else typed += char;
      }
    }
    stdin.on('data', onData);
  });
}

async function readPiped() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.replace(/\r?\n$/, '');
}

async function main() {
  let password;
  if (process.stdin.isTTY) {
    password = await askHidden('Password: ');
    if ((await askHidden('Again: ')) !== password) throw new Error('The two entries did not match');
  } else {
    password = await readPiped();
  }
  if (password.length < MIN_LENGTH) {
    throw new Error(`Use at least ${MIN_LENGTH} characters: this password is all that stands between the internet and the tracker`);
  }
  console.error('Put this line in .env, then restart the app:');
  console.log(`AUTH_PASSWORD_HASH=${await hashPassword(password)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
