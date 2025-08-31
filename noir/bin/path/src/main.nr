use consts::{HONK_IDENTIFIER, HONK_PROOF_SIZE, HONK_VK_SIZE};

fn main(
    child_vk: [Field; HONK_VK_SIZE],
    child_proof: [Field; HONK_PROOF_SIZE],
    child_public_inputs: [Field; 2], // [start, end] of child segment
    x: Field,
) -> pub [Field; 2] {
    std::verify_proof_with_type(child_vk, child_proof, child_public_inputs, 0x0, HONK_IDENTIFIER);
    let start = child_public_inputs[0];
    let end = child_public_inputs[1];
    assert(x == end + 1);
    [start, x]
}
