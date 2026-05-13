// Verbatim re-host of `transform/tests/snapshots/literal_value.sparql.nr`.
use dep::consts;
use dep::types::Triple;

pub(crate) type BGP = [Triple; 1];
pub(crate) struct Variables {
  pub(crate) s: Field,
}

pub(crate) fn checkBinding(bgp: BGP, variables: Variables) {
  assert(variables.s == bgp[0].terms[0].hash);
  assert(consts::hash2([0, consts::encode_string("http://example.org/label")]) == bgp[0].terms[1].hash);
  assert(consts::hash2([2, consts::hash4([consts::encode_string("hello"), consts::encode_string("hello"), consts::encode_string(""), consts::encode_string("http://www.w3.org/2001/XMLSchema#string")])]) == bgp[0].terms[2].hash);
}
