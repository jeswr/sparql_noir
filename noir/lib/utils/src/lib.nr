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
            if triple.directions[i - 1] == 0 { [current, triple.path[i]] } else { [triple.path[i], current] }
        );
    }
    // TODO: Cleanup - we shouldn't need this check
    assert_eq(current, root_value, "Path does not lead to the correct root");
    assert_eq(consts::hash4(triple.terms), triple.path[0], "Triple does not hash to the root");
}

pub fn encode_string<let N: u32>(string: str<N>) -> Field {
    Field::from_le_bytes(consts::hash_string(string.as_bytes()))
}

pub fn merkle<let M: u32, let N: u32>(triples: [[Field; 4]; N]) {
    let mut tree = [[0; 1024]; M];
    let mut paths = [[0; M]; N];
    let mut pathDirection = [[0; M - 1]; N];

    for i in 0..triples.len() {
        tree[0][i] = consts::hash4(triples[i]);
    }

    for i in 1..M {
        let mut max: u32 = 1;
        for _ in 0..(M - 1 - i) {
            max *= 2;
        }

        for j in 0..max {
            tree[i][j] = consts::hash2([tree[i - 1][j * 2], tree[i - 1][j * 2 + 1]]);
        }
    }

    // Generate paths for each triple
    for i in 0..triples.len() {
        let mut index = i;

        paths[i][0] = tree[0][i];

        for j in 1..M {
            paths[i][j] = tree[j - 1][index ^ 1]; // XOR to get the sibling node
            pathDirection[i][j - 1] = if index % 2 == 0 { 0 } else { 1 }; // 0 for left, 1 for right
            index /= 2; // Move up the tree
        }
    }

    let root = tree[M - 1][0];
    let root_u8: [u8; 32] = root.to_le_bytes();

    println(
        f"{{
        \"triples\": {triples}
        ,\"root\": {root}
        , \"root_u8\": {root_u8}
        , \"paths\": {paths}
        , \"direction\": {pathDirection}
        }}",
    );
}

#[test]
fn test_encode_string() {
    assert_eq(encode_string("hello"), 0x25ca40f156e40bb07e99a8ccf8863d0b33bb7ca4b9cee3bd6dee8dc5ac3b2119);
}
