import { derivePublicKey, signMessage, verifySignature } from "@zk-kit/eddsa-poseidon";

const privateKey = Buffer.alloc(32);
privateKey.writeUInt32BE(123, 28);

const publicKey = derivePublicKey(privateKey);
console.log(publicKey);

const signature = signMessage(privateKey, Buffer.from([789]));
console.log(signature);

const isValid = verifySignature(Buffer.from([789]), signature, publicKey);
console.log(isValid);

export { publicKey, signature, isValid };
