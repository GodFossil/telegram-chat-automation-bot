import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function openStore(file) {
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return {
    chat(key) {
      return state[key] ??= { paused: false, until: 0, history: [], seen: [] };
    },
    save() {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    },
  };
}
