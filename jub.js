import { packPoint, unpackPoint, Base8, mulPointEscalar, addPoint } from "@zk-kit/baby-jubjub";

let priv_key_a = 123;
let msg = 789;

const gen = [
  995203441582195749578291179787384436505546430278305826713579947235728471134n,
  5472060717959818805561601436314318772137091100104008585924551046643952123905n,
]

// function eddsa_to_pub(secret) {
//   return mulPointEscalar(Base8, secret)
// }

// console.log(Base8);
console.log(mulPointEscalar(gen, BigInt(priv_key_a)));

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