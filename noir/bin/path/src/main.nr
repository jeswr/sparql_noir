use consts::{HONK_IDENTIFIER, HONK_PROOF_SIZE, HONK_VK_SIZE};

struct Proof {
    pub vk: [Field; HONK_VK_SIZE],
    pub proof: [Field; HONK_PROOF_SIZE],
    pub public_inputs: [Field; 2],
}

fn main(
    proof: Proof,
    x: Field,
) -> pub [Field; 2] {
    std::verify_proof_with_type(proof.vk, proof.proof, proof.public_inputs, 0x0, HONK_IDENTIFIER);
    let start = proof.public_inputs[0];
    let end = proof.public_inputs[1];
    assert(x == end + 1);
    [start, x]
}
