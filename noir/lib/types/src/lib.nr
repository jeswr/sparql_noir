use dep::consts::MERKLE_DEPTH;

pub struct Triple {
  pub terms: [Field; 4],
  pub path: [Field; MERKLE_DEPTH],
  pub directions: [u8; MERKLE_DEPTH - 1],
}

pub struct PubKey {
  pub x: [u8; 32],
  pub y: [u8; 32],
}

pub struct Root {
  pub value: Field,
  pub signature: [u8; 64],
}

pub struct Proof {
  pub vk: [Field; HONK_VK_SIZE],
  pub proof: [Field; HONK_PROOF_SIZE],
  pub public_inputs: [Field; 2],
}
