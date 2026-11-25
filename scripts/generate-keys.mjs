import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...privateKey.export({ format: 'jwk' }), kid: randomUUID(), alg: 'RS256', use: 'sig' };
mkdirSync('.keys', { recursive: true, mode: 0o700 });
writeFileSync('.keys/oidc.json', JSON.stringify({ keys: [key] }), { mode: 0o600, flag: 'wx' });
console.log(`Generated .keys/oidc.json. Set AUTH_SECRET=${randomBytes(32).toString('hex')}`);
