use dep::types::{Root, Triple};
use dep::consts;

pub struct MerkleInfo<let M: u32, let N: u32> {
    pub triples: [[Field; 4]; N],
    pub root: Field,
    pub root_u8: [u8; 32],
    pub paths: [[Field; M]; N],
    pub direction: [[u8; M - 1]; N],
}

pub fn verify_signature(public_key: consts::signature::PubKey, root: Root) {
    assert(
        consts::signature::verify_signature(public_key, root.signature, root.value),
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

pub fn merkle<let M: u32, let N: u32>(triples: [[Field; 4]; N]) -> MerkleInfo<M, N> {
    let mut tree = [[0; 1024]; M];
    let mut paths = [[0; M]; N];
    let mut direction = [[0; M - 1]; N];

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
            direction[i][j - 1] = if index % 2 == 0 { 0 } else { 1 }; // 0 for left, 1 for right
            index /= 2; // Move up the tree
        }
    }

    let root = tree[M - 1][0];
    let root_u8: [u8; 32] = root.to_le_bytes();

    MerkleInfo {
        triples,
        root,
        root_u8,
        paths,
        direction,
    }
}

#[test]
fn test_merkle() {
    let merkle_info = merkle::<11, 3>([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]]);
    assert_eq(merkle_info.root, 0x18fcec159d1858cbf97fc2257c9e319c8039d28d37c29bfdadd2528a0953421b);
}
