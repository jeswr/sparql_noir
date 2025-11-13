pub type PubKey = std::embedded_curve_ops::EmbeddedCurvePoint;

pub type Signature = [u8; 64];

pub fn verify_signature(pubkey: PubKey, signature: Signature, message: Field) -> bool {
  dep::schnorr::verify_signature(pubkey, signature, message.to_le_bytes::<32>())
}
