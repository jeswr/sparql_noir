// import { publicKey, signature, isValid } from './dist/eddsa.js';
// console.log(publicKey);
// console.log(signature);
// console.log(isValid);

const { EdDSAPoseidon, derivePublicKey, signMessage, verifySignature } = require("@zk-kit/eddsa-poseidon");
const ed = new EdDSAPoseidon('0x' + BigInt(123).toString(16));
const msg = 14271713263066645060561179139372875058535071287055680648183956122812668267828n;

// const privateKey = Buffer.from([123]);
// privateKey.writeUInt32BE(123, 28);

const publicKey = ed.publicKey;
console.log(publicKey.map(p => '0x' + p.toString(16)));

const signature = ed.signMessage(msg);
console.log({
  r: {
    x: '0x' + signature.R8[0].toString(16),
    y: '0x' + signature.R8[1].toString(16)
  },
  s: '0x' + signature.S.toString(16)
});

const isValid = verifySignature(msg, signature, publicKey);
console.log(isValid);

// 0x16b051f37589e0dcf4ad3c415c090798c10d3095bedeedabfcc709ad787f3507
// 0x062800ac9e60839fab9218e5ed9d541f4586e41275f4071816a975895d349a5e
// 0x112b0979943746dfd82db66ee20a3ab530afb3a98acc928802a70300dbe93c
// 0x163814666f04c4d2969059a6b63ee26a0f9f0f81bd5957b0796e2e8f4a8a2f06
// 0x1255b17d9e4bfb81831625b788f8a1665128079ac4b6c8c3cd1b857666a05a54
// 0x0315
// 0x060c89ce5c263405370a08b6d0302b0bab3eedb83920ee0a677297dc392126f1
