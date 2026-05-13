// Verbatim re-host of `transform/tests/snapshots/filter_bound.sparql.nr`.
use dep::consts;
use dep::types::Triple;

pub(crate) type BGP = [Triple; 1];
pub(crate) struct Variables {
  pub(crate) s: Field,
}

pub(crate) fn checkBinding(bgp: BGP, variables: Variables) {
  assert(variables.s == bgp[0].terms[0].hash);
  assert(consts::hash2([0, consts::encode_string("http://example.org/knows")]) == bgp[0].terms[1].hash);
  assert(true);
}
