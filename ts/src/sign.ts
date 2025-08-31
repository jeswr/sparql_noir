import { UltraHonkBackend, Barretenberg, RawBuffer } from "@aztec/bb.js";
import { type CompiledCircuit, Noir } from "@noir-lang/noir_js";

import sign from "../../noir/bin/signature/target/signature.json" with { type: "json" };

async function vkAsFields(bytecode: string, bb: Barretenberg) {
  const backend = new UltraHonkBackend(bytecode, undefined, { recursive: true });
  const vk = await backend.getVerificationKey();
  const fields = (await bb.acirVkAsFieldsUltraHonk(new RawBuffer(vk))).map((f) => f.toString());
  return { backend, fields };
}

const noir = new Noir(sign as CompiledCircuit);
const bb = await Barretenberg.new();
const { backend } = await vkAsFields(sign.bytecode, bb);

console.time("noir.execute");
const { witness } = await noir.execute({
  public_key: {
    x: [
      173, 163, 204, 183, 18, 90, 15, 227, 112, 105, 205, 180, 75, 55, 193, 239, 74, 255,
      76, 248, 206, 124, 158, 221, 192, 66, 160, 248, 23, 72, 248, 151,
    ],
    y: [
      167, 127, 250, 109, 2, 177, 107, 151, 78, 155, 131, 244, 77, 89, 153, 18, 20, 38,
      152, 83, 148, 5, 169, 4, 217, 41, 25, 110, 255, 136, 194, 189,
    ],
  },
  root: {
    value: "0x048482e2f303d87dd199be0800b91ee2961e34c462177f1bf57553e5a5a304c9",
    signature: [
      65, 17, 164, 223, 68, 0, 163, 33, 3, 89, 48, 4, 58, 152, 13, 33, 96, 67, 118, 94,
      48, 183, 170, 208, 252, 10, 233, 95, 249, 8, 227, 171, 79, 122, 62, 230, 198, 111,
      102, 57, 141, 70, 141, 50, 227, 247, 82, 9, 60, 52, 198, 45, 15, 179, 244, 188, 64,
      222, 199, 135, 34, 48, 131, 245,
    ],
  },
});
console.timeEnd("noir.execute");

console.time("bb.createProof");
const { proof, publicInputs } = await backend.generateProof(witness);
console.timeEnd("bb.createProof");

// Verify
console.time("bb.verifyProof");
const isValid = await backend.verifyProof({ proof, publicInputs });
console.log({ isValid });
console.timeEnd("bb.verifyProof");

// Clean up resources to allow process to exit
await backend.destroy();
await bb.destroy();
