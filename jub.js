import { runJson } from './dist/encode.js'

const suborder = 2736030358979909402780800718157159386076813972158567259200215660948447373041n

const out = runJson('utils::eddsa_to_pub(123, 789)');
console.log(out);
console.log(BigInt(out.pub_key.x) % suborder);
console.log(BigInt(out.pub_key.y) % suborder);
console.log(BigInt(out.r8.x) % suborder);
console.log(BigInt(out.r8.y) % suborder);
// console.log(BigInt('0x060c89ce5c263405370a08b6d0302b0bab3eedb83920ee0a677297dc392126f1'));

// EmbeddedCurvePoint { x: 0x1d955a97520e36780bb41d35ea714a6760e349fd09ea40f3075953e7d5f2edb4, y: 0x2990a1d1f09e6fdc625652241b270a92be2003a637938a6b3c630c42aa1f0b22, is_infinite: false }
// 0x060c89ce5c263405370a08b6d0302b0bab3eedb83920ee0a677297dc392126f1
// 0x0320bb59f0f360dfa986326e327b48316c55509cdbb39db6f28684f4ec6a986a
// 0x16b051f37589e0dcf4ad3c415c090798c10d3095bedeedabfcc709ad787f3507
// 0x062800ac9e60839fab9218e5ed9d541f4586e41275f4071816a975895d349a5e
// 0x112b0979943746dfd82db66ee20a3ab530afb3a98acc928802a70300dbe93c
// 0x163814666f04c4d2969059a6b63ee26a0f9f0f81bd5957b0796e2e8f4a8a2f06
// 0x1255b17d9e4bfb81831625b788f8a1665128079ac4b6c8c3cd1b857666a05a54
// 0x0315
// 0x060c89ce5c263405370a08b6d0302b0bab3eedb83920ee0a677297dc392126f1
// true

// const { pub_key: { x, y }, r8 } = runJson('utils::eddsa_to_pub(123, 789)');
// console.log(BigInt(x) % suborder, BigInt(y) % suborder, BigInt(r8.x) % suborder, BigInt(r8.y) % suborder);

// import { packPoint, unpackPoint, Base8, mulPointEscalar, addPoint } from "@zk-kit/baby-jubjub";

// let priv_key_a = 123;
// let msg = 789;

// const gen = [
//   995203441582195749578291179787384436505546430278305826713579947235728471134n,
//   5472060717959818805561601436314318772137091100104008585924551046643952123905n,
// ]

// function eddsa_to_pub(secret) {
//   return mulPointEscalar(Base8, secret)
// }

// console.log(Base8);
// console.log(mulPointEscalar(gen, BigInt(priv_key_a)));

// Define two points on the BabyJubJub curve.
// const p1 = [BigInt(0), BigInt(1)] // Point at infinity (neutral element).
// const p2 = [BigInt(1), BigInt(0)] // Example point.

// // Add the two points on the curve.
// const p3 = addPoint(p1, p2)

// // Add the result with Base8, another point on the curve, to get a new point.
// const secretScalar = addPoint(Base8, p3)

// // Multiply the base point by the x-coordinate of the secret scalar to get the public key.
// const publicKey = mulPointEscalar(Base8, secretScalar[0])

// // Pack the public key into a compressed format.
// const packedPoint = packPoint(publicKey)

// // Unpack the compressed public key back into its original form.
// const unpackedPoint = unpackPoint(packedPoint)

// if (unpackedPoint) {
//     console.log(publicKey[0] === unpackedPoint[0]) // true, checks if x-coordinates match
//     console.log(publicKey[1] === unpackedPoint[1]) // true, checks if y-coordinates match
// }