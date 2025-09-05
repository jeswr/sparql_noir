pub struct PubKey {
  pub x: [u8; 32],
  pub y: [u8; 32],
}

pub type Signature = [u8; 64];

pub fn verify_signature(public_key: PubKey, signature: Signature, message: Field) -> bool {
  std::ecdsa_secp256k1::verify_signature(public_key.x, public_key.y, signature, message.to_le_bytes())
}
