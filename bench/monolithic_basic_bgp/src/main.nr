// Verbatim re-host of `transform/tests/snapshots/basic_bgp.main.nr`.
// Pair-row in `bench/readable-vs-monolithic.md`.

mod sparql;

use dep::types::Root;
use dep::utils::{verify_inclusion, verify_signature};
use dep::consts::signature::PubKey;

use sparql::{BGP, checkBinding, Variables};

fn main(
    public_key: [PubKey; 1],
    roots: [Root; 1],
    bgp: BGP,
    variables: pub Variables,
) {
    for i in 0..1 {
        verify_signature(public_key[0], roots[i]);
    }
    for triple in bgp {
        verify_inclusion(triple, roots[0].value);
    }
    checkBinding(bgp, variables)
}
