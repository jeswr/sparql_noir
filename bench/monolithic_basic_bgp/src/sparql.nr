// Verbatim re-host of `transform/tests/snapshots/basic_bgp.sparql.nr`.
use dep::consts;
use dep::types::Triple;

pub(crate) type BGP = [Triple; 1];
pub(crate) struct Variables {
  pub(crate) s: Field,
  pub(crate) p: Field,
  pub(crate) o: Field,
}

pub(crate) fn checkBinding(bgp: BGP, variables: Variables) {
  assert(variables.s == bgp[0].terms[0].hash);
  assert(variables.p == bgp[0].terms[1].hash);
  assert(variables.o == bgp[0].terms[2].hash);
}
