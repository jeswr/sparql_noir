use dep::consts::{MERKLE_DEPTH, HONK_VK_SIZE, HONK_PROOF_SIZE, signature::Signature};

pub struct Triple {
  pub terms: [Field; 4],
  pub path: [Field; MERKLE_DEPTH],
  pub directions: [u8; MERKLE_DEPTH - 1],
}

pub struct Root {
  pub value: Field,
  pub signature: Signature,
}

pub struct IndexedRoot {
  pub index: u32,
  pub root: Root,
}

pub struct Proof {
  pub vk: [Field; HONK_VK_SIZE],
  pub proof: [Field; HONK_PROOF_SIZE],
  pub public_inputs: [Field; 2],
}
