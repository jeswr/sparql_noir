
use dep::types::Triple;
use dep::utils::verify_inclusion;

fn main(triple: pub Triple, root_value: pub Field) {
    verify_inclusion(triple, root_value);
}
