use dep::types::{PubKey, Root, Triple};
use dep::consts;

pub fn verify_signature(public_key: PubKey, root: Root) {
    let message: [u8; 32] = root.value.to_le_bytes();
    // Check that the signature on the merkle root is valid
    assert(
        consts::verify_signature(public_key.x, public_key.y, root.signature, message),
        "Signature verification failed",
    );
}

pub fn verify_inclusion(triple: Triple, root_value: Field) {
    let mut current = triple.path[0];
    for i in 1..consts::MERKLE_DEPTH {
        current = consts::hash2(
            if triple.directions[i - 1] == 0 { [current, triple.path[i]] } else { [triple.path[i], current] },
        );
    }
    // TODO: Cleanup - we shouldn't need this check
    assert_eq(current, root_value, "Path does not lead to the correct root");
    assert_eq(consts::hash4(triple.terms), triple.path[0], "Triple does not hash to the root");
}

pub fn encode_string<let N: u32>(string: str<N>) -> Field {
    Field::from_le_bytes(consts::hash_string(string.as_bytes()))
}

#[test]
fn test_encode_string() {
    assert_eq(encode_string("hello"), 0x25ca40f156e40bb07e99a8ccf8863d0b33bb7ca4b9cee3bd6dee8dc5ac3b2119);
}
