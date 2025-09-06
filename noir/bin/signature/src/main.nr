use dep::types::Root;
use dep::utils::verify_signature;
use dep::consts::signature::PubKey;

fn main(public_key: pub PubKey, root: pub Root) {
    verify_signature(public_key, root);
}
