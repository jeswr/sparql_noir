// Verbatim re-host of `transform/tests/snapshots/filter_comparison.sparql.nr`.
use dep::consts;
use dep::types::Triple;

pub(crate) type BGP = [Triple; 1];
pub(crate) struct Variables {
  pub(crate) s: Field,
  pub(crate) o: Field,
}

pub(crate) type Hidden = [Field; 4];
pub(crate) fn checkBinding(bgp: BGP, variables: Variables, hidden: Hidden) {
  assert(variables.s == bgp[0].terms[0].hash);
  assert(variables.o == bgp[0].terms[2].hash);
  assert(consts::hash2([0, consts::encode_string("http://example.org/knows")]) == bgp[0].terms[1].hash);
  assert((!(hidden[0] == hidden[1])) & ((hidden[2] as i64) > (hidden[3] as i64)));
}
